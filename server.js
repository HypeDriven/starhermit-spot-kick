'use strict';

/*
 * Spot Kick authoritative dev server (LOCAL DEV ONLY — the repo's own
 * backend for `npm start`; these session and leaderboard routes are never
 * called on StarHermit, where hosted play uses realtime rooms, see js/net.js,
 * and leaderboards are platform-owned/read-only, see js/platform.js).
 * - Static distribution server (no external deps).
 * - GET  /api/v1/time                    platform time (round-trip adjusted client-side)
 * - POST /api/v1/session                 create private match {build, contentVersion, ai?}
 * - POST /api/v1/session/:code/join      join as player B
 * - GET  /api/v1/session/:code?token=    snapshot (reconnect source of truth)
 * - POST /api/v1/session/:code/command   validated move {token, command}
 * - GET  /api/v1/leaderboard?board=      boards (global / daily-YYYY-MM-DD)
 * - POST /api/v1/leaderboard             score submission, verified by replay
 *
 * All rules run inside this sandboxed JS script via js/rules.js. Client clocks,
 * scores and winners are never trusted; commands are validated for identity,
 * membership, tick, bounds, rate, size and legality, and deduplicated by ID.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('./js/rules');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = process.env.SPOT_KICK_DATA_DIR || path.join(ROOT, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BOARDS_FILE = path.join(DATA_DIR, 'leaderboard.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.opus': 'audio/ogg; codecs=opus'
};

const MAX_BODY = 64 * 1024;           // payload size bound
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 240;                 // requests per window per IP
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

// ---------- persistence ----------
let sessions = {};
let boards = {};
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  boards = JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
} catch (_) { /* fresh start */ }
let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
      fs.writeFileSync(BOARDS_FILE, JSON.stringify(boards));
    } catch (_) {}
  }, 400);
}

// ---------- rate limiting ----------
const rate = {};
function rateOk(ip) {
  const now = Date.now();
  const r = rate[ip] || (rate[ip] = []);
  while (r.length && now - r[0] > RATE_WINDOW_MS) r.shift();
  if (r.length >= RATE_MAX) return false;
  r.push(now);
  return true;
}

// ---------- helpers ----------
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function err(res, code, msg) { send(res, code, { error: msg }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}
function token() { return crypto.randomBytes(12).toString('hex'); }
function makeCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += abc[crypto.randomInt(abc.length)];
  return sessions[c] ? makeCode() : c;
}

// Hide hidden information: the shooter must not see the committed dive.
function sanitize(sess, side) {
  const st = rules.clone(sess.state);
  if (st.pendingDive && rules.keeperSide(st) !== side) st.pendingDive = { hidden: true };
  return st;
}

function waitingFor(sess) {
  const st = sess.state;
  if (st.over) return null;
  if (!sess.players.A || !sess.players.B) return null;
  return st.phase === 'keeper' ? rules.keeperSide(st) : st.shooter;
}

function snapshotPayload(sess, side) {
  return {
    code: sess.code,
    state: sanitize(sess, side),
    waitingFor: waitingFor(sess),
    players: { A: !!sess.players.A, B: !!sess.players.B },
    result: sess.envelope.result || null
  };
}

// Deterministic server-side AI fills side B when requested or on abandonment.
function aiPump(sess) {
  let guard = 0;
  while (!sess.state.over && guard++ < 6) {
    const st = sess.state;
    const side = st.phase === 'keeper' ? rules.keeperSide(st) : st.shooter;
    if (sess.players[side] !== 'ai') break;
    const params = st.phase === 'keeper'
      ? rules.aiChooseDive(st, sess.aiDifficulty)
      : rules.aiChooseShot(st, sess.aiDifficulty);
    applyServerCommand(sess, {
      id: 'srv-' + sess.code + '-' + sess.envelope.commands.length,
      tick: st.tick, type: st.phase === 'keeper' ? 'dive' : 'shoot', player: side, params: params
    });
  }
}

function applyServerCommand(sess, cmd) {
  if (sess.applied[cmd.id]) return { ok: true, duplicate: true, state: sess.state };
  const res = rules.applyCommand(sess.state, cmd);
  if (res.ok || res.countedInvalid) {
    sess.state = res.state;
    sess.applied[cmd.id] = true;
    sess.envelope.commands.push(cmd);
    sess.envelope.hashes.push(rules.hashState(res.state));
    if (res.state.over) {
      sess.envelope.result = {
        winner: res.state.winner,
        terminalReason: res.state.terminalReason,
        breakdown: rules.breakdown(res.state),
        elapsedMs: Date.now() - sess.createdAt // authoritative clock
      };
    }
    persistSoon();
  }
  return res;
}

// ---------- API ----------
async function api(req, res, url) {
  if (url.pathname === '/time' && req.method === 'GET') {
    return send(res, 200, { now: Date.now() });
  }

  if (url.pathname === '/session' && req.method === 'POST') {
    const body = await readBody(req);
    const code = makeCode();
    const seed = crypto.randomInt(0, 0xffffffff) >>> 0;
    const state = rules.createInitialState({ seed: seed, rounds: 5 });
    const sess = {
      code: code, createdAt: Date.now(), lastActive: Date.now(),
      aiDifficulty: 1,
      state: state,
      players: { A: token(), B: body && body.ai ? 'ai' : null },
      applied: {},
      envelope: rules.createReplayEnvelope({ build: body.build || 'unknown', contentVersion: body.contentVersion || 1 }, state)
    };
    sessions[code] = sess;
    aiPump(sess);
    persistSoon();
    return send(res, 200, Object.assign({ token: sess.players.A, side: 'A' }, snapshotPayload(sess, 'A')));
  }

  const mJoin = url.pathname.match(/^\/session\/([A-Z0-9]{5})\/join$/);
  if (mJoin && req.method === 'POST') {
    const sess = sessions[mJoin[1]];
    if (!sess) return err(res, 404, 'no-such-session');
    if (sess.state.over) return err(res, 410, 'match-over');
    if (sess.players.B && sess.players.B !== 'ai') return err(res, 409, 'match-full');
    sess.players.B = token();
    sess.lastActive = Date.now();
    persistSoon();
    return send(res, 200, Object.assign({ token: sess.players.B, side: 'B' }, snapshotPayload(sess, 'B')));
  }

  const mSess = url.pathname.match(/^\/session\/([A-Z0-9]{5})$/);
  if (mSess && req.method === 'GET') {
    const sess = sessions[mSess[1]];
    if (!sess) return err(res, 404, 'no-such-session');
    const tok = url.searchParams.get('token') || '';
    const side = sess.players.A === tok ? 'A' : (sess.players.B === tok ? 'B' : null);
    if (!side) return err(res, 403, 'bad-token');
    sess.lastActive = Date.now();
    return send(res, 200, snapshotPayload(sess, side));
  }

  const mCmd = url.pathname.match(/^\/session\/([A-Z0-9]{5})\/command$/);
  if (mCmd && req.method === 'POST') {
    const sess = sessions[mCmd[1]];
    if (!sess) return err(res, 404, 'no-such-session');
    const body = await readBody(req);
    const side = sess.players.A === body.token ? 'A' : (sess.players.B === body.token ? 'B' : null);
    if (!side || side === 'ai') return err(res, 403, 'bad-token');
    const cmd = body.command;
    if (!cmd || cmd.player !== side) return err(res, 403, 'not-your-side');
    if (sess.state.over) return err(res, 409, 'match-over');
    const res1 = applyServerCommand(sess, cmd);
    if (!res1.ok) return err(res, 422, res1.reason || 'rejected');
    sess.lastActive = Date.now();
    aiPump(sess);
    return send(res, 200, Object.assign({ duplicate: !!res1.duplicate }, snapshotPayload(sess, side)));
  }

  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    const board = url.searchParams.get('board') || 'global';
    const list = (boards[board] || []).slice().sort((a, b) => b.score - a.score || a.durationMs - b.durationMs).slice(0, 50);
    return send(res, 200, { board: board, entries: list });
  }

  if (url.pathname === '/leaderboard' && req.method === 'POST') {
    const body = await readBody(req);
    // Reject impossible or stale-version scores; verify by full replay.
    if (!body || typeof body !== 'object') return err(res, 400, 'malformed');
    if (body.ruleset !== rules.VERSION) return err(res, 422, 'stale-ruleset');
    if (typeof body.score !== 'number' || body.score < 0 || body.score > 99) return err(res, 422, 'impossible-score');
    if (!body.replay || !Array.isArray(body.replay.commands)) return err(res, 422, 'missing-replay');
    const check = rules.replayMatch(body.replay);
    if (!check.ok) return err(res, 422, 'replay-' + (check.reason || 'invalid'));
    if (check.state.scoreA !== body.score) return err(res, 422, 'score-mismatch');
    const board = String(body.board || 'global').slice(0, 40);
    const entry = {
      name: String(body.name || 'Guest').slice(0, 24),
      score: body.score, conceded: body.conceded | 0,
      ruleset: body.ruleset, contentVersion: body.contentVersion | 0,
      seed: body.replay.seed >>> 0,
      assists: Array.isArray(body.assists) ? body.assists.slice(0, 5) : [],
      durationMs: Math.max(0, body.durationMs | 0),
      at: Date.now()
    };
    (boards[board] || (boards[board] = [])).push(entry);
    persistSoon();
    return send(res, 200, { ok: true, rank: boards[board].filter(e => e.score > entry.score).length + 1 });
  }

  return err(res, 404, 'no-such-route');
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('bad path'); }
  if (rel.split(/[\\/]/).some(part => part.startsWith('.') || ['data', 'node_modules', 'tests'].includes(part))) {
    res.writeHead(404); return res.end('not found');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': file.endsWith('three.min.js') ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- housekeeping ----------
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(sessions)) {
    const s = sessions[code];
    if (now - s.lastActive > SESSION_TTL_MS) { delete sessions[code]; persistSoon(); }
  }
}, 10 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/v1')) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateOk(ip)) return err(res, 429, 'rate-limited');
      const apiUrl = new URL(url);
      apiUrl.pathname = url.pathname.slice(7) || '/';
      return await api(req, res, apiUrl);
    }
    serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', e && e.stack || e);
    err(res, e && e.message === 'payload-too-large' ? 413 : 400, e && e.message || 'error');
  }
});

module.exports = { server, sessions, boards };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('spot-kick listening on http://localhost:' + PORT);
  });
}
