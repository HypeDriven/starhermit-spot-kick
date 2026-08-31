'use strict';

const http = require('http');
const { server } = require('../server');
const rules = require('../js/rules');
const session = require('../js/session');

let port, base;
beforeAll(done => { server.listen(0, () => { port = server.address().port; base = 'http://127.0.0.1:' + port; done(); }); });
afterAll(done => { server.close(() => done()); });

async function api(path, opts) {
  const res = await fetch(base + '/api/v1' + path, {
    method: (opts && opts.method) || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  return { status: res.status, data: await res.json() };
}

describe('server API', () => {
  test('GET /time returns platform time', async () => {
    const r = await api('/time');
    expect(r.status).toBe(200);
    expect(Math.abs(r.data.now - Date.now())).toBeLessThan(5000);
  });

  test('static index.html served', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPOT KICK');
  });

  test('hosted two-player match: create, join, hidden dive, validated commands, authoritative result', async () => {
    const c = await api('/session', { method: 'POST', body: { build: 'test', contentVersion: 1 } });
    expect(c.status).toBe(200);
    const code = c.data.code, tokA = c.data.token;
    expect(c.data.side).toBe('A');

    // bad token rejected
    const bad = await api('/session/' + code + '?token=nope');
    expect(bad.status).toBe(403);

    const j = await api('/session/' + code + '/join', { method: 'POST', body: {} });
    expect(j.status).toBe(200);
    const tokB = j.data.token;

    // B dives (keeper first)
    const diveCmd = { id: 'k1', tick: 0, type: 'dive', player: 'B', params: { dir: 'left', height: 'low', timing: 'on' } };
    const d1 = await api('/session/' + code + '/command', { method: 'POST', body: { token: tokB, command: diveCmd } });
    expect(d1.status).toBe(200);
    expect(d1.data.state.phase).toBe('shooter');
    // dive hidden from the shooter (A)
    const snapA = await api('/session/' + code + '?token=' + tokA);
    expect(snapA.data.state.pendingDive).toEqual({ hidden: true });
    // keeper sees own dive
    const snapB = await api('/session/' + code + '?token=' + tokB);
    expect(snapB.data.state.pendingDive.dir).toBe('left');

    // duplicate command is idempotent
    const dup = await api('/session/' + code + '/command', { method: 'POST', body: { token: tokB, command: diveCmd } });
    expect(dup.status).toBe(200);
    expect(dup.data.duplicate).toBe(true);
    expect(dup.data.state.tick).toBe(1);

    // out-of-turn rejected
    const oot = await api('/session/' + code + '/command', { method: 'POST', body: { token: tokB, command: { id: 'k2', tick: 1, type: 'shoot', player: 'B', params: { dir: 'left', height: 'low', curve: 'none' } } } });
    expect(oot.status).toBe(422);

    // wrong side rejected
    const wrong = await api('/session/' + code + '/command', { method: 'POST', body: { token: tokB, command: { id: 'k3', tick: 1, type: 'shoot', player: 'A', params: { dir: 'left', height: 'low', curve: 'none' } } } });
    expect(wrong.status).toBe(403);

    // legal shot resolves
    const shotCmd = { id: 'k4', tick: 1, type: 'shoot', player: 'A', params: { dir: 'right', height: 'high', curve: 'none' } };
    const sh = await api('/session/' + code + '/command', { method: 'POST', body: { token: tokA, command: shotCmd } });
    expect(sh.status).toBe(200);
    expect(sh.data.state.scoreA).toBe(1);
    expect(sh.data.waitingFor).toBe('A'); // A now keeps
  });

  test('AI hosted match completes autonomously against player commands', async () => {
    const c = await api('/session', { method: 'POST', body: { ai: true } });
    const code = c.data.code, tokA = c.data.token;
    let guard = 0, snap = c.data;
    while (!snap.state.over && guard++ < 40) {
      if (snap.waitingFor === 'A') {
        const st = snap.state;
        const cmd = st.phase === 'keeper'
          ? { id: 'a' + guard, tick: st.tick, type: 'dive', player: 'A', params: { dir: 'center', height: 'low', timing: 'on' } }
          : { id: 'a' + guard, tick: st.tick, type: 'shoot', player: 'A', params: { dir: 'left', height: 'high', curve: 'none' } };
        snap = (await api('/session/' + code + '/command', { method: 'POST', body: { token: tokA, command: cmd } })).data;
      } else break;
    }
    expect(snap.state.over).toBe(true);
    expect(snap.result).toBeTruthy();
    expect(snap.result.winner).toMatch(/^[AB]$/);
  });

  test('leaderboard rejects forged and accepts verified scores', async () => {
    // forged: score doesn't match replay
    const fake = await api('/leaderboard', { method: 'POST', body: {
      board: 'test', score: 9, ruleset: rules.VERSION, contentVersion: 1, replay: { seed: 1, rounds: 1, constraints: {}, initialHash: 'x', commands: [], hashes: [] }
    } });
    expect(fake.status).toBe(422);

    // genuine: play a full local match and submit its replay
    const m = session.createSession({ seed: 31337, rounds: 3, ai: { side: 'B', difficulty: 0 } });
    session.begin(m, 0);
    let guard = 0;
    while (!m.state.over && guard++ < 60) {
      session.aiAct(m);
      const st = m.state;
      if (st.over) break;
      if (st.phase === 'keeper') session.submit(m, 'dive', 'A', { dir: 'left', height: 'low', timing: 'on' });
      else session.submit(m, 'shoot', 'A', { dir: 'right', height: 'high', curve: 'none' });
    }
    const env = session.exportReplay(m);
    const okR = await api('/leaderboard', { method: 'POST', body: {
      board: 'test', name: 'Tester', score: m.state.scoreA, conceded: m.state.scoreB,
      ruleset: rules.VERSION, contentVersion: 1, durationMs: 1234, assists: [], replay: env
    } });
    expect(okR.status).toBe(200);
    expect(okR.data.ok).toBe(true);

    const board = await api('/leaderboard?board=test');
    expect(board.status).toBe(200);
    expect(board.data.entries.length).toBeGreaterThan(0);

    // stale ruleset rejected
    const stale = await api('/leaderboard', { method: 'POST', body: {
      board: 'test', score: m.state.scoreA, ruleset: 999, contentVersion: 1, replay: env
    } });
    expect(stale.status).toBe(422);
  });

  test('path traversal blocked', async () => {
    const res = await fetch(base + '/..%2f..%2fpackage.json');
    expect([403, 404]).toContain(res.status);
  });
});
