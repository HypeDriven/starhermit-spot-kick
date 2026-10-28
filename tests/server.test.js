'use strict';
// server.js — the platform script: score posting (score-script.js's range
// checks) and the room-bound online referee. Evaluated as the platform does:
// one classic script in a fresh context without Date or Math.random.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const rules = require('../js/rules');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function load() {
  const ctx = { JSON, Object, Array, Number, String, Math: Object.create(Math), isFinite, Date: undefined };
  ctx.Math.random = () => { throw new Error('Math.random in server.js'); };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx.game;
}
const roster = (b) => ({ roomId: 'r1', metadata: {}, roster: [
  { userId: 'alice', name: 'alice', team: 0, slot: 0, ai: false },
  b === 'ai' ? { userId: null, name: 'Bot', team: 0, slot: 1, ai: true } : { userId: 'bob', name: 'bob', team: 0, slot: 1, ai: false },
] });
function match(opts = {}) {
  const g = load();
  let ss = g.createSession({ now: 0, random: 0.25, sessionId: 's', players: [], room: roster(opts.b) }).sessionState;
  const send = (from, data, now = 1) => {
    const r = g.onPlayerMessage({ now, sessionState: JSON.parse(JSON.stringify(ss)), message: { from, data } });
    if (r.sessionState) ss = r.sessionState;
    return r;
  };
  const tick = (presence, now) => {
    const r = g.onTick({ now, sessionState: JSON.parse(JSON.stringify(ss)), presence });
    if (r.sessionState) ss = r.sessionState;
    return r;
  };
  return { g, send, tick, get ss() { return ss; } };
}

test('server.js is built from js/rules.js and tools/server-*.js', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-server.mjs'), '--check'], { stdio: 'pipe' });
});

test('score posting: range-checked goals, the session ends', () => {
  const g = load();
  const ss = g.createSession({ now: 5, sessionId: 'p', players: [] }).sessionState;
  assert.equal(ss.kind, 'score');
  const ok = g.onPlayerMessage({ now: 6, sessionState: ss, message: { from: 'alice', data: { type: 'result', scores: { goals: 4 } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.scores)), { goals: { alice: 4 } });
  assert.equal(ok.result.kind, 'finished');
  assert.deepEqual(JSON.parse(JSON.stringify(ok.broadcast[0].data)), { type: 'result-ack', accepted: ['goals'] });
  for (const bad of [-1, 101, 2.5, 'x', Infinity]) {
    const r = g.onPlayerMessage({ now: 6, sessionState: ss, message: { from: 'alice', data: { type: 'result', scores: { goals: bad } } } });
    assert.deepEqual(JSON.parse(JSON.stringify(r.scores)), {}, String(bad));
  }
  assert.equal(g.onPlayerMessage({ now: 6, sessionState: ss, message: { from: 'a', data: { type: 'nope' } } }).ok, false);
});

test('online: sync sends the table and a snapshot with the dive hidden', () => {
  const m = match();
  const sync = m.send('alice', { type: 'sync' });
  assert.deepEqual(JSON.parse(JSON.stringify(sync.broadcast.map((b) => b.data.type))), ['table', 'snap']);
  assert.deepEqual(JSON.parse(JSON.stringify(sync.broadcast[0].data.seats.map((s) => s.side + s.userId))), ['Aalice', 'Bbob']);
  assert.equal(sync.broadcast[1].data.waitingFor, 'B'); // A shoots first: B keeps
  const r = m.send('bob', { type: 'dive', tick: 0, id: 'd1', params: { dir: 'left', height: 'low', timing: 'on' } });
  const snap = r.broadcast[0].data;
  assert.equal(snap.state.pendingDive, null);
  assert.equal(snap.committed, true);
  assert.equal(snap.waitingFor, 'A');
  assert.equal(m.ss.state.pendingDive.dir, 'left'); // kept server-side
});

test('online: only the sender\'s own side acts; stale ticks and resent ids', () => {
  const m = match();
  const wrong = m.send('alice', { type: 'dive', tick: 0, id: 'x', params: { dir: 'left', height: 'low', timing: 'on' } });
  assert.equal(wrong.broadcast[0].data.type, 'rejected');
  assert.equal(m.send('eve', { type: 'dive', tick: 0, params: {} }).ok, false);
  const stale = m.send('bob', { type: 'dive', tick: 3, id: 'y', params: { dir: 'left', height: 'low', timing: 'on' } });
  assert.equal(stale.broadcast[0].data.reason, 'stale-tick');
  m.send('bob', { type: 'dive', tick: 0, id: 'd1', params: { dir: 'left', height: 'low', timing: 'on' } });
  const again = m.send('bob', { type: 'dive', tick: 0, id: 'd1', params: { dir: 'left', height: 'low', timing: 'on' } });
  assert.equal(again.broadcast, undefined); // already applied
  const kick = m.send('alice', { type: 'shoot', tick: 1, id: 's1', params: { dir: 'left', height: 'low', curve: 'none' } });
  assert.equal(kick.broadcast[0].data.kick.outcome, 'saved');
  assert.equal(kick.broadcast[0].data.kick.dive.dir, 'left'); // revealed with the kick
});

test('online: a whole match to the result, matching the rules replayed locally', () => {
  const m = match();
  let local = rules.createInitialState({ seed: Math.floor(0.25 * 4294967295) >>> 0, rounds: 5 });
  let i = 0, over = null;
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; };
  const pick = () => ['left', 'center', 'right'][rnd(3)];
  while (!over && i < 400) {
    const st = m.ss.state;
    const keeper = st.phase === 'keeper';
    const side = keeper ? rules.keeperSide(st) : st.shooter;
    const from = side === 'A' ? 'alice' : 'bob';
    const params = keeper ? { dir: pick(), height: rnd(2) ? 'high' : 'low', timing: 'on' } : { dir: pick(), height: rnd(2) ? 'low' : 'high', curve: 'none' };
    const cmd = { id: 'c' + i, tick: st.tick, type: keeper ? 'dive' : 'shoot', player: side, params };
    local = rules.applyCommand(local, cmd).state;
    const r = m.send(from, { type: cmd.type, tick: cmd.tick, id: cmd.id, params });
    assert.equal(r.broadcast[0].data.type, 'snap');
    if (r.result) over = r;
    i++;
  }
  assert.ok(over, 'the match ended');
  assert.equal(over.result.kind, 'win');
  assert.equal(over.result.winnerUserId, local.winner === 'A' ? 'alice' : 'bob');
  assert.deepEqual(JSON.parse(JSON.stringify(over.result.teamScores)), [local.scoreA, local.scoreB]);
  const end = over.broadcast.find((b) => b.data.type === 'over').data;
  assert.equal(end.finalHash, rules.hashState(local));
  assert.equal(m.send('alice', { type: 'shoot', tick: 99, params: {} }).broadcast[0].data.reason, 'match-over');
});

test('online: an AI seat takes its own turns', () => {
  const m = match({ b: 'ai' });
  assert.equal(m.ss.state.phase, 'shooter'); // the AI dived at once
  const r = m.send('alice', { type: 'shoot', tick: m.ss.state.tick, id: 's', params: { dir: 'right', height: 'high', curve: 'none' } });
  const snap = r.broadcast[0].data;
  assert.ok(snap.kick);
  assert.equal(snap.waitingFor, 'A'); // now A keeps: the AI shoots once A's dive is in
});

test('online: leaving or staying offline for 60 s concedes', () => {
  let m = match();
  let r = m.tick({ alice: { online: true, left: false }, bob: { online: true, left: true } }, 10);
  assert.equal(r.result.winnerUserId, 'alice');
  assert.equal(r.result.reason, 'forfeit');
  m = match();
  m.tick({ alice: { online: false, left: false }, bob: { online: true, left: false } }, 1000);
  assert.equal(m.tick({ alice: { online: false, left: false }, bob: { online: true, left: false } }, 50000).result, undefined);
  r = m.tick({ alice: { online: false, left: false }, bob: { online: true, left: false } }, 62000);
  assert.equal(r.result.winnerUserId, 'bob');
  m = match();
  r = m.send('bob', { type: 'forfeit' });
  assert.equal(r.result.winnerUserId, 'alice');
});
