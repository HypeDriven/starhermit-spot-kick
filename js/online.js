// Online matches: StarHermit realtime rooms for the lobby, and the session the
// platform binds to a started room for the match, refereed by server.js
// (after ~/games/poker src/online.js).
//
// Create online match makes a room of one team with two seats and opens it for
// quick join; Quick join a match joins an open room of this game or, when there
// is none, creates and opens one. Once both seats are taken the room starts
// (the host also asks for the start, which is idempotent) and the platform
// binds a session running server.js; every client then opens the session's
// game socket, sends { type: 'sync' } on every (re)connection and its dives and
// shots as commands. The script answers with the table, snapshots (the
// committed dive hidden), rejections and the end of the match; the result is
// the script's (no client ever posts one). A room that starts without a bound
// session is not played.
//
// `platform` is the adapter native/platform.ts provides (and the node tests
// fake): { userId, createRoom, openRoom, startRoom, leaveRoom, getRoom,
// quickJoin, myRoom, connectRoom(roomId, handlers), connectGame(sessionId,
// handlers) }.

export const SEATS = 2;
/** The platform disconnects a client that sends commands faster than the session's tick (1 Hz). */
export const CMD_MIN_INTERVAL_MS = 1000;

export function newRoom() {
  return { teamCount: 1, seatsPerTeam: SEATS, backfillAiPlayers: false, metadata: { mode: '1v1' } };
}

const errKind = (e) => (e && (e.kind || e.code)) || '';
const conflict = (e) => {
  const k = errKind(e);
  return k === 'conflict' || k === 'active-room-elsewhere' || (e && e.status === 409);
};
// One active room per player: when creating or joining conflicts, rejoin the room the player already holds.
async function recoverConflict(platform, e) {
  if (conflict(e)) {
    const room = await platform.myRoom().catch(() => null);
    if (room && room.status !== 'closed') return room;
  }
  throw e;
}

/** Create online match: a new room, opened for quick join. */
export async function createMatch(platform) {
  try {
    const room = await platform.createRoom(newRoom());
    return await platform.openRoom(room.id).catch(() => room);
  } catch (e) { return recoverConflict(platform, e); }
}

/** Quick join: an open room of this game, else a new one opened for the next player. `created` says which. */
export async function quickJoin(platform) {
  try {
    const joined = await platform.quickJoin();
    if (joined) return { room: joined, created: false };
    return { room: await createMatch(platform), created: true };
  } catch (e) { return { room: await recoverConflict(platform, e), created: false }; }
}

export function isHost(room, userId) { return !!room && !!userId && room.hostUserId === userId; }

/** The lobby: the room's roster until it plays. */
export class LobbyClient {
  /** hooks: onChange(), onPlaying(room) when the bound session is there, onClosed(reason). */
  constructor(platform, room, hooks = {}) {
    this.platform = platform;
    this.hooks = hooks;
    this.room = room;
    this.connected = false;
    this.unavailable = false;
    this._socket = null;
    this._handedOff = false;
    this._startAsked = false;
  }
  get host() { return isHost(this.room, this.platform.userId); }
  get participants() { return (this.room && this.room.participants) || []; }
  _emit(name, ...args) { const fn = this.hooks[name]; if (fn) fn(...args); }

  connect() {
    if (this._socket) return;
    this._socket = this.platform.connectRoom(this.room.id, {
      onOpen: () => { this.connected = true; this._emit('onChange'); },
      onDown: () => { this.connected = false; this._emit('onChange'); },
      onRoster: (room) => this._onRoster(room),
      onStopped: (reason) => {
        this.connected = false;
        if (reason !== 'closed') { this.unavailable = true; this._emit('onClosed', reason); }
        this._emit('onChange');
      },
    });
    void this.refresh();
  }

  async refresh() {
    try {
      const room = await this.platform.getRoom(this.room.id);
      if (room) this._onRoster(room);
      else { this.unavailable = true; this._emit('onClosed', 'gone'); }
    } catch { /* the socket's roster keeps it current */ }
  }

  _onRoster(room) {
    this.room = { ...this.room, ...room };
    const st = this.room.status;
    if (st === 'playing' && this.room.gameSessionId && !this._handedOff) {
      this._handedOff = true;
      this._emit('onPlaying', this.room);
    } else if (st === 'closed') {
      this.unavailable = true;
      this._emit('onClosed', 'closed');
    } else if ((st === 'lobby' || st === 'open') && this.host && this.participants.length >= SEATS && !this._startAsked) {
      // both seats taken: start (idempotent; the platform may already be starting the open room)
      this._startAsked = true;
      this.platform.startRoom(this.room.id).then((r) => { if (r) this._onRoster(r); }, () => { this._startAsked = false; });
    }
    this._emit('onChange');
  }

  async leave() {
    this.close();
    try { await this.platform.leaveRoom(this.room.id); } catch { /* already gone */ }
  }
  close() {
    if (this._socket) { try { this._socket.close(); } catch { /* gone */ } }
    this._socket = null;
  }
}

/** The match: the bound session's game socket and the latest view the script sent. */
export class MatchClient {
  /** opts: now() (ms), hooks: onTable(table), onSnap(snap), onRejected(reason), onOver(over), onChange(). */
  constructor(platform, room, opts = {}) {
    this.platform = platform;
    this.room = room;
    this.sessionId = room.gameSessionId;
    this.now = opts.now || (() => 0);
    this.hooks = opts.hooks || {};
    this.table = null;
    this.snap = null;
    this.over = null;
    this.connected = false;
    this.unavailable = false;
    this.queue = [];
    this.lastSentAt = null;
    this._game = null;
    this._room = null;
  }
  _emit(name, ...args) { const fn = this.hooks[name]; if (fn) fn(...args); }

  /** This player's side ('A' | 'B'), once the table arrived. */
  get side() {
    const me = this.platform.userId;
    const seat = this.table && this.table.seats.find((s) => s.userId && s.userId === me);
    return seat ? seat.side : null;
  }

  connect() {
    if (this._game) return;
    this._game = this.platform.connectGame(this.sessionId, {
      onOpen: () => {
        this.connected = true;
        this.lastSentAt = null;
        this.queue = this.queue.filter((q) => q.type !== 'sync');
        this.queue.unshift({ type: 'sync' }); // every (re)connection resyncs first
        this.update();
        this._emit('onChange');
      },
      onDown: () => { this.connected = false; this._emit('onChange'); },
      onMessage: (data) => this._onGame(data),
      onError: (message) => this._emit('onRejected', String(message || 'rejected')),
      onStopped: (reason) => {
        this.connected = false;
        if (reason !== 'closed') this.unavailable = true;
        this._emit('onChange');
      },
    });
    // The room's socket stays open for the roster (the platform closes a playing room whose host has no socket).
    if (this.room.id) {
      this._room = this.platform.connectRoom(this.room.id, { onRoster: (room) => { this.room = { ...this.room, ...room }; } });
    }
  }

  /** Queues a dive or shot for the current tick. */
  send(cmd) {
    this.queue.push(cmd);
    this.update();
  }

  /** Called every frame: drains the queue at the session's pace. */
  update() {
    if (!this._game || !this.connected || !this.queue.length) return;
    if (this.lastSentAt !== null && this.now() - this.lastSentAt < CMD_MIN_INTERVAL_MS) return;
    if (!this._game.send(this.queue[0])) return; // paced or down: try again next frame
    this.queue.shift();
    this.lastSentAt = this.now();
  }

  _onGame(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'table') { this.table = data; this._emit('onTable', data); }
    else if (data.type === 'snap') {
      if (this.snap && data.state && this.snap.state && data.state.tick < this.snap.state.tick) return; // stale
      this.snap = data;
      this._emit('onSnap', data);
    } else if (data.type === 'rejected') this._emit('onRejected', String(data.reason || 'rejected'));
    else if (data.type === 'over') { this.over = data; this._emit('onOver', data); }
    this._emit('onChange');
  }

  /** Leave match: concede (the script decides), then leave the room. */
  async leave() {
    if (this._game && this.connected && !this.over) { try { this._game.send({ type: 'forfeit' }); } catch { /* gone */ } }
    this.close();
    if (this.room.id) { try { await this.platform.leaveRoom(this.room.id); } catch { /* gone */ } }
  }
  close() {
    for (const s of [this._game, this._room]) if (s) { try { s.close(); } catch { /* gone */ } }
    this._game = null;
    this._room = null;
  }
}
