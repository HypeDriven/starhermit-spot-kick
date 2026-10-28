// js/online.js against a fake platform: creating and quick-joining rooms, the
// host's start once both seats are taken, the hand-off to the bound session,
// the game socket's resync, pacing and the script's messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LobbyClient, MatchClient, createMatch, quickJoin, CMD_MIN_INTERVAL_MS } from '../js/online.js';

function fakePlatform(userId = 'alice') {
  const calls = [];
  const sockets = { room: [], game: [] };
  const rooms = new Map();
  const p = {
    userId, calls, sockets, rooms,
    createRoom: async (cfg) => { calls.push(['create', cfg]); const r = { id: 'r1', status: 'lobby', hostUserId: userId, participants: [{ id: 'p1', userId }] }; rooms.set(r.id, r); return r; },
    openRoom: async (id) => { calls.push(['open', id]); const r = { ...rooms.get(id), status: 'open' }; rooms.set(id, r); return r; },
    startRoom: async (id) => { calls.push(['start', id]); return { ...rooms.get(id), status: 'playing', gameSessionId: 's1' }; },
    leaveRoom: async (id) => { calls.push(['leave', id]); },
    getRoom: async (id) => rooms.get(id) ?? null,
    quickJoin: async () => { calls.push(['quickJoin']); return p.open ?? null; },
    myRoom: async () => null,
    connectRoom: (id, h) => { const s = { id, h, closed: false, close() { this.closed = true; } }; sockets.room.push(s); return s; },
    connectGame: (id, h) => { const s = { id, h, sent: [], ok: true, send(d) { if (!this.ok) return false; this.sent.push(d); return true; }, close() {} }; sockets.game.push(s); return s; },
  };
  return p;
}

test('create opens the new room; quick join falls back to creating one', async () => {
  const p = fakePlatform();
  const room = await createMatch(p);
  assert.equal(room.status, 'open');
  assert.deepEqual(p.calls.map((c) => c[0]), ['create', 'open']);
  assert.deepEqual(p.calls[0][1], { teamCount: 1, seatsPerTeam: 2, backfillAiPlayers: false, metadata: { mode: '1v1' } });
  const q = await quickJoin(p);
  assert.equal(q.created, true);
  p.open = { id: 'r9', status: 'open', hostUserId: 'bob', participants: [] };
  const j = await quickJoin(p);
  assert.deepEqual([j.created, j.room.id], [false, 'r9']);
});

test('the lobby: the host starts once both seats are taken, then hands off', async () => {
  const p = fakePlatform();
  const room = await createMatch(p);
  let playing = null;
  const lobby = new LobbyClient(p, room, { onPlaying: (r) => { playing = r; } });
  lobby.connect();
  const sock = p.sockets.room[0];
  sock.h.onRoster({ status: 'open', participants: [{ id: 'p1', userId: 'alice' }] });
  assert.ok(!p.calls.some((c) => c[0] === 'start'));
  sock.h.onRoster({ status: 'open', participants: [{ id: 'p1', userId: 'alice' }, { id: 'p2', userId: 'bob' }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.calls.filter((c) => c[0] === 'start').length, 1);
  assert.equal(playing.gameSessionId, 's1');
});

test('the match: sync first on every connection, commands paced, messages routed', () => {
  const p = fakePlatform('bob');
  let t = 0;
  const seen = [];
  const m = new MatchClient(p, { id: 'r1', gameSessionId: 's1' }, {
    now: () => t,
    hooks: { onTable: () => seen.push('table'), onSnap: (s) => seen.push('snap' + s.state.tick), onRejected: (r) => seen.push('rej:' + r), onOver: () => seen.push('over') },
  });
  m.connect();
  const g = p.sockets.game[0];
  m.send({ type: 'dive', tick: 0 });
  assert.equal(g.sent.length, 0); // not connected yet
  g.h.onOpen();
  assert.deepEqual(g.sent, [{ type: 'sync' }]);
  m.update();
  assert.equal(g.sent.length, 1); // paced
  t += CMD_MIN_INTERVAL_MS;
  m.update();
  assert.deepEqual(g.sent[1], { type: 'dive', tick: 0 });
  g.h.onMessage({ type: 'table', seats: [{ side: 'A', userId: 'alice' }, { side: 'B', userId: 'bob' }] });
  assert.equal(m.side, 'B');
  g.h.onMessage({ type: 'snap', state: { tick: 2 } });
  g.h.onMessage({ type: 'snap', state: { tick: 1 } }); // stale: dropped
  g.h.onMessage({ type: 'rejected', reason: 'out-of-turn' });
  g.h.onMessage({ type: 'over', winner: 'A' });
  assert.deepEqual(seen, ['table', 'snap2', 'rej:out-of-turn', 'over']);
  g.h.onOpen(); // reconnection: resync again
  t += CMD_MIN_INTERVAL_MS;
  m.update();
  assert.deepEqual(g.sent[g.sent.length - 1], { type: 'sync' });
});

test('leave concedes before leaving the room', async () => {
  const p = fakePlatform();
  const m = new MatchClient(p, { id: 'r1', gameSessionId: 's1' }, {});
  m.connect();
  p.sockets.game[0].h.onOpen();
  await m.leave();
  assert.deepEqual(p.sockets.game[0].sent[p.sockets.game[0].sent.length - 1], { type: 'forfeit' });
  assert.ok(p.calls.some((c) => c[0] === 'leave'));
});
