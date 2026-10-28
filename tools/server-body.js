var Rules = SpotKickRules;

// BOARDS:BEGIN — JSON, read by tools/leaderboards.mjs to create the boards.
var BOARDS = {
  "goals": { "name": "Goals scored", "scoreType": "integer", "sortDirection": "desc", "minScore": 0, "maxScore": 100 }
};
// BOARDS:END

var HOSTED = { rounds: 5, aiDifficulty: 1 };
var OFFLINE_FORFEIT_MS = 60000;
var SIDES = ['A', 'B'];

function validScore(board, v) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  if (board.scoreType !== 'decimal' && Math.floor(v) !== v) return false;
  if (board.scoreType === 'time-ms' && v < 0) return false;
  if (board.minScore != null && v < board.minScore) return false;
  if (board.maxScore != null && v > board.maxScore) return false;
  return true;
}

// ---------------------------------------------------------------- online matches

/** Side A is the first seat (slot 0, or team 0 when the room has two teams), side B the second. */
function seatsFromRoom(ctx) {
  var roster = ((ctx.room && ctx.room.roster) || []).slice();
  roster.sort(function (a, b) { return ((a.team || 0) - (b.team || 0)) || ((a.slot || 0) - (b.slot || 0)); });
  var seats = [null, null];
  for (var i = 0; i < roster.length && i < 2; i++) {
    var r = roster[i];
    var ai = !!r.ai || !r.userId;
    seats[i] = { userId: ai ? null : r.userId, name: String(r.displayName || r.name || (ai ? 'AI' : 'Player')).slice(0, 40), ai: ai };
  }
  for (var s = 0; s < 2; s++) if (!seats[s]) seats[s] = { userId: null, name: 'AI', ai: true };
  return seats;
}

function newMatch(ctx) {
  var seed = Math.floor((ctx.random || 0) * 4294967295) >>> 0;
  var ss = {
    kind: 'match',
    seats: seatsFromRoom(ctx),
    state: Rules.createInitialState({ seed: seed, rounds: HOSTED.rounds }),
    seen: [],
    offlineSince: [null, null],
    over: null,
    summary: { status: 'active' }
  };
  aiTurns(ss, []);
  return ss;
}

function sideOf(ss, userId) {
  if (!userId) return null;
  for (var i = 0; i < 2; i++) if (ss.seats[i].userId === userId) return SIDES[i];
  return null;
}
function seatIndex(side) { return side === 'B' ? 1 : 0; }

/** Whose choice the rules wait for (null when over). */
function waitingFor(state) {
  if (state.over) return null;
  return state.phase === 'keeper' ? Rules.keeperSide(state) : state.shooter;
}

/** The state both clients see: the committed dive hidden until its kick resolves. */
function publicState(state) {
  var s = JSON.parse(JSON.stringify(state));
  s.pendingDive = null;
  s.rng = 0; s.rngAi = 0;
  return s;
}

function snapMsg(ss, kick) {
  return { type: 'snap', state: publicState(ss.state), waitingFor: waitingFor(ss.state), committed: !!ss.state.pendingDive, kick: kick || null };
}
function tableMsg(ss) {
  return {
    type: 'table',
    seats: ss.seats.map(function (s, i) { return { side: SIDES[i], name: s.name, ai: s.ai, userId: s.userId }; })
  };
}

/** Applies a command; collects its kick-resolved event. */
function apply(ss, cmd, kicks) {
  var res = Rules.applyCommand(ss.state, cmd);
  if (res.state) ss.state = res.state;
  if (res.ok && res.events) {
    for (var i = 0; i < res.events.length; i++) if (res.events[i].type === 'kick-resolved') kicks.push(res.events[i]);
  }
  return res;
}

/** The AI seats take every turn that is theirs. */
function aiTurns(ss, kicks) {
  for (var guard = 0; guard < 4 && !ss.state.over; guard++) {
    var st = ss.state;
    var side = waitingFor(st);
    if (!side || !ss.seats[seatIndex(side)].ai) return;
    var type = st.phase === 'keeper' ? 'dive' : 'shoot';
    var params = type === 'dive' ? Rules.aiChooseDive(st, HOSTED.aiDifficulty) : Rules.aiChooseShot(st, HOSTED.aiDifficulty);
    apply(ss, { id: 'ai-' + st.tick, tick: st.tick, type: type, player: side, params: params }, kicks);
  }
}

/** Ends the match (the rules' end, or a forfeit): the `over` broadcast and the platform's result. */
function finish(ss, ret) {
  var st = ss.state;
  var w = st.winner === 'B' ? 1 : 0;
  ss.over = { winner: st.winner, reason: st.terminalReason, breakdown: Rules.breakdown(st), finalHash: Rules.hashState(st) };
  ss.summary = { status: 'finished' };
  ret.broadcast.push({ to: 'all', data: { type: 'over', winner: ss.over.winner, reason: ss.over.reason, breakdown: ss.over.breakdown, finalHash: ss.over.finalHash } });
  ret.result = {
    kind: 'win',
    reason: st.terminalReason,
    winnerSeat: w,
    winnerUserId: ss.seats[w].userId,
    teamScores: [st.scoreA, st.scoreB]
  };
}

function forfeit(ss, side) {
  var st = ss.state;
  if (st.over) return;
  st.over = true;
  st.winner = side === 'A' ? 'B' : 'A';
  st.terminalReason = 'forfeit';
  st.phase = 'over';
  st.pendingDive = null;
}

function matchMessage(ctx) {
  var ss = ctx.sessionState;
  var data = (ctx.message && ctx.message.data) || {};
  var from = ctx.message && ctx.message.from;
  if (!ss || ss.kind !== 'match') return { ok: false, error: 'No match' };
  if (data.type === 'sync') {
    var out = [{ to: [from], data: tableMsg(ss) }, { to: [from], data: snapMsg(ss, null) }];
    if (ss.over) out.push({ to: [from], data: { type: 'over', winner: ss.over.winner, reason: ss.over.reason, breakdown: ss.over.breakdown, finalHash: ss.over.finalHash } });
    return { ok: true, broadcast: out };
  }
  var side = sideOf(ss, from);
  if (!side) return { ok: false, error: 'Not seated' };
  var ret = { ok: true, broadcast: [] };
  if (data.type === 'forfeit') {
    if (ss.over) return { ok: true };
    forfeit(ss, side);
    ret.broadcast.push({ to: 'all', data: snapMsg(ss, null) });
    finish(ss, ret);
    ret.sessionState = ss;
    return ret;
  }
  if (data.type !== 'dive' && data.type !== 'shoot') return { ok: false, error: 'Unknown command' };
  if (ss.over) return { ok: true, broadcast: [{ to: [from], data: { type: 'rejected', reason: 'match-over' } }] };
  var id = typeof data.id === 'string' ? data.id.slice(0, 64) : '';
  if (id && ss.seen.indexOf(side + ':' + id) >= 0) return { ok: true }; // a resent command: already applied
  var p = data.params && typeof data.params === 'object' ? data.params : {};
  var params = data.type === 'dive'
    ? { dir: String(p.dir || ''), height: String(p.height || ''), timing: String(p.timing || '') }
    : { dir: String(p.dir || ''), height: String(p.height || ''), curve: String(p.curve || '') };
  var tick = typeof data.tick === 'number' ? data.tick : -1;
  var kicks = [];
  var res = apply(ss, { id: id || ('c' + ss.state.tick), tick: tick, type: data.type, player: side, params: params }, kicks);
  if (!res.ok) {
    ret.broadcast.push({ to: [from], data: { type: 'rejected', reason: res.reason || 'rejected' } });
    if (res.countedInvalid) ret.broadcast.push({ to: 'all', data: snapMsg(ss, null) });
    ret.sessionState = ss;
    return ret;
  }
  if (id) { ss.seen.push(side + ':' + id); if (ss.seen.length > 32) ss.seen.shift(); }
  aiTurns(ss, kicks);
  ret.broadcast.push({ to: 'all', data: snapMsg(ss, kicks.length ? kicks[kicks.length - 1] : null) });
  if (ss.state.over) finish(ss, ret);
  ret.sessionState = ss;
  return ret;
}

function matchTick(ctx) {
  var ss = ctx.sessionState;
  if (!ss || ss.kind !== 'match' || ss.over) return { ok: true };
  var presence = ctx.presence || {};
  var ret = { ok: true, broadcast: [] };
  var changed = false;
  // Presence: a player who left the room concedes; so does one offline for 60 s.
  for (var i = 0; i < 2 && !ss.state.over; i++) {
    var uid = ss.seats[i].userId;
    if (!uid) continue;
    var pr = presence[uid];
    if (pr && pr.left) { forfeit(ss, SIDES[i]); changed = true; continue; }
    if (pr && pr.online === false) {
      if (ss.offlineSince[i] == null) { ss.offlineSince[i] = ctx.now; changed = true; }
      else if (ctx.now - ss.offlineSince[i] > OFFLINE_FORFEIT_MS) { forfeit(ss, SIDES[i]); changed = true; }
    } else if (ss.offlineSince[i] != null) { ss.offlineSince[i] = null; changed = true; }
  }
  if (!changed) return { ok: true };
  if (ss.state.over) {
    ret.broadcast.push({ to: 'all', data: snapMsg(ss, null) });
    finish(ss, ret);
  }
  ret.sessionState = ss;
  return ret;
}

// ---------------------------------------------------------------- score posting

function scoreMessage(ctx) {
  var data = (ctx.message && ctx.message.data) || {};
  if (data.type !== 'result' || !data.scores || typeof data.scores !== 'object') {
    return { ok: false, error: 'Unknown command' };
  }
  var from = ctx.message.from;
  var scores = {}, accepted = [], n = 0;
  for (var key in BOARDS) {
    if (!Object.prototype.hasOwnProperty.call(BOARDS, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(data.scores, key) || n >= 16) continue;
    var v = data.scores[key];
    if (!validScore(BOARDS[key], v)) continue;
    scores[key] = {}; scores[key][from] = v; accepted.push(key); n++;
  }
  var state = ctx.sessionState || {};
  state.summary = { status: 'finished' };
  return {
    ok: true,
    sessionState: state,
    scores: scores,
    broadcast: [{ to: [from], data: { type: 'result-ack', accepted: accepted } }],
    result: { kind: 'finished', reason: 'result' }
  };
}

globalThis.game = {
  // Presence (forfeits) is read once a second; every move is a command.
  tickRateHz: 1,

  createSession: function (ctx) {
    if (ctx.room) return { ok: true, sessionState: newMatch(ctx) };
    return { ok: true, sessionState: { kind: 'score', startedAt: ctx.now, summary: { status: 'active' } } };
  },

  onPlayerMessage: function (ctx) {
    if (ctx.sessionState && ctx.sessionState.kind === 'match') return matchMessage(ctx);
    return scoreMessage(ctx);
  },

  onTick: function (ctx) {
    if (ctx.sessionState && ctx.sessionState.kind === 'match') return matchTick(ctx);
    return { ok: true };
  }
};
