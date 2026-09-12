'use strict';

/*
 * Spot Kick platform adapter.
 *
 * Local/dev mode (no token): same-origin /api/v1 adapter against the repo's
 * own server.js — server-time sync, hosted session client (create/join/poll/
 * command) and replay-verified leaderboard submission. Guest play works fully
 * offline; no tokens are ever persisted.
 *
 * Hosted mode (StarHermit platform): activates only when a launch token was
 * read from the URL — fragment #game_token=<jwt> (read once, then stripped;
 * query ?token=/&launch=/&launch_token= remain as local-dev fallbacks). The
 * JWT payload (base64url decode, no verify) carries sub (user id) and
 * game_scope (this game's slug — never hard-coded). The token lives in
 * memory only, is sent as Authorization: Bearer on every call, and is
 * re-minted every 45 min via POST /api/v1/games/{slug}/launch-token.
 * Hosted extras: account nickname (GET /api/v1/users/{id}/profile — never
 * /api/v1/me, never usernames), cloud save mirror (GET/PUT /api/v1/me/
 * cloud-saves/{gameKey}, one zip+base64 slot, remote wins on load,
 * localStorage stays the offline cache), read-only platform leaderboards,
 * and realtime rooms (see js/net.js). The repo's own session and
 * leaderboard routes are never called in hosted mode (they 404 on-platform).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const BASE = '/api/v1';
  let timeOffset = 0;         // serverNow - clientNow
  let timeSynced = false;
  let online = true;

  function now() { return Date.now() + (timeSynced ? timeOffset : 0); }

  // ---- launch token -----------------------------------------------------------

  /** Read the launch token once, then strip it from the URL. Returns null offline. */
  function readLaunchToken() {
    if (typeof location === 'undefined' || typeof history === 'undefined') return null;
    if (location.hash && location.hash.length > 1) {
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const token = params.get('game_token');
        if (token) {
          params.delete('game_token');
          params.delete('session_id');
          const rest = params.toString();
          history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
          return token;
        }
      } catch (_) { /* malformed fragment; fall through to query */ }
    }
    // Local-dev fallbacks only — the platform always delivers the fragment.
    try {
      const q = new URLSearchParams(location.search);
      const token = q.get('token') || q.get('launch') || q.get('launch_token');
      if (token) history.replaceState(null, '', location.pathname + location.hash);
      return token;
    } catch (_) {
      return null;
    }
  }

  /** Decode a JWT payload segment (base64url) without verifying the signature. */
  function decodeJwtPayload(token) {
    try {
      const seg = token.split('.')[1];
      const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const claims = JSON.parse(json);
      return claims && typeof claims === 'object' ? claims : null;
    } catch (_) {
      return null;
    }
  }

  const token = readLaunchToken();
  const claims = token ? decodeJwtPayload(token) : null;
  const sub = claims && typeof claims.sub === 'string' ? claims.sub : null;
  const gameSlug = claims && typeof claims.game_scope === 'string' ? claims.game_scope : null;
  let refreshTimer = null;

  function hosted() { return !!token; }

  function scheduleRefresh(delayMs) {
    if (typeof setTimeout === 'undefined') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshToken, delayMs);
    if (refreshTimer.unref) refreshTimer.unref();
  }

  /** Re-mint the scoped launch token; failures retry in ~60 s. */
  async function refreshToken() {
    if (!token || !gameSlug) return;
    try {
      const res = await fetch(BASE + '/games/' + encodeURIComponent(gameSlug) + '/launch-token', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('http-' + res.status);
      const body = await res.json();
      if (body && typeof body.token === 'string' && body.token) liveToken.token = body.token;
      scheduleRefresh(45 * 60 * 1000);
    } catch (_) {
      scheduleRefresh(60 * 1000);
    }
  }

  // The token swaps on refresh; everything reads the live value.
  const liveToken = { token: token };

  if (token) scheduleRefresh(45 * 60 * 1000);

  // ---- REST helper -------------------------------------------------------------

  async function fetchJson(path, opts, retries) {
    opts = opts || {};
    retries = retries === undefined ? 2 : retries;
    const init = { method: opts.method || 'GET', headers: {} };
    if (liveToken.token) init.headers['Authorization'] = 'Bearer ' + liveToken.token;
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let attempt = 0, lastErr = null;
    while (attempt <= retries) {
      try {
        const res = await fetch(BASE + path, init);
        let data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        if (res.status === 429) { // rate limited: recoverable, back off
          await sleep(400 * Math.pow(2, attempt++));
          continue;
        }
        if (data && typeof data.error === 'string') {
          return { ok: false, error: data.error, status: res.status };
        }
        if (!res.ok) return { ok: false, error: 'http-' + res.status, status: res.status };
        online = true;
        return { ok: true, data: data };
      } catch (e) {
        lastErr = e;
        await sleep(300 * Math.pow(2, attempt++));
      }
    }
    online = false;
    return { ok: false, error: 'offline', cause: String(lastErr || '') };
  }

  /** Raw authenticated fetch for non-JSON payloads (cloud save bytes). */
  async function fetchApi(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (liveToken.token) headers['Authorization'] = 'Bearer ' + liveToken.token;
    return fetch(BASE + path, Object.assign({}, opts, { headers: headers }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function syncTime() {
    if (hosted()) {
      // Platform time route; silent local-clock fallback when absent.
      try {
        const t0 = Date.now();
        const res = await fetchApi('/time', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const serverNow = data && typeof data.now === 'number' ? data.now : null;
          if (serverNow !== null) {
            const t1 = Date.now();
            timeOffset = serverNow - ((t0 + t1) / 2); // round-trip adjusted
            timeSynced = true;
            online = true;
            return timeSynced;
          }
        }
      } catch (_) { /* offline: keep local clock */ }
      timeSynced = false;
      return false;
    }
    const t0 = Date.now();
    const res = await fetchJson('/time', {}, 1);
    if (res.ok && res.data && typeof res.data.now === 'number') {
      const t1 = Date.now();
      timeOffset = res.data.now - ((t0 + t1) / 2); // round-trip adjusted
      timeSynced = true;
    }
    return timeSynced;
  }

  function isOnline() { return online; }

  // ---- account identity ---------------------------------------------------------

  const profileCache = new Map();

  /**
   * Resolve a user id to a display nickname (cached). Never returns usernames;
   * falls back to "Player " + id8. Offline callers get the fallback.
   */
  async function profileFor(userId) {
    if (profileCache.has(userId)) return profileCache.get(userId);
    let rec = null;
    if (liveToken.token) {
      try {
        const res = await fetchApi('/users/' + encodeURIComponent(userId) + '/profile');
        if (res.ok) rec = await res.json();
      } catch (_) { /* offline; fall back below */ }
    }
    const nick = rec && typeof rec.nickname === 'string' && rec.nickname.trim()
      ? rec.nickname.trim()
      : 'Player ' + String(userId).slice(0, 8);
    profileCache.set(userId, nick);
    return nick;
  }

  /** Load the signed-in player's nickname into the identity slot. */
  async function fetchProfile() {
    if (!sub) return null;
    return profileFor(sub);
  }

  function displayName() {
    if (!hosted() || !sub) return null;
    return profileCache.get(sub) || ('Player ' + String(sub).slice(0, 8));
  }

  // ---- cloud save (one zip+base64 slot; localStorage stays the offline cache) ----

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  let syncStatus = 'offline';           // offline | saving | synced
  let onSync = null;                    // fn(status)
  let cloudTimer = null;
  let lastPushed = null;                // dedupe identical pushes

  function setSync(status) {
    if (syncStatus === status) return;
    syncStatus = status;
    if (onSync) onSync(status);
  }

  function getSyncStatus() { return syncStatus; }

  /** Mirror the checksummed local save doc (encoded string) to the cloud slot. */
  async function pushCloudSave(encodedSave, keepalive) {
    if (!hosted() || !gameSlug) return;
    if (encodedSave === lastPushed) { setSync('synced'); return; }
    try {
      const zip = zipStore('save.json', new TextEncoder().encode(encodedSave));
      const res = await fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(gameSlug), {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + liveToken.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ dataBase64: bytesToBase64(zip) }),
        keepalive: !!keepalive
      });
      setSync(res.ok ? 'synced' : 'offline');
      if (res.ok) lastPushed = encodedSave;
    } catch (_) {
      setSync('offline');
    }
  }

  /** Debounced mirror (~2 s); flush on pagehide / hidden visibilitychange. */
  function queueCloudSave(encodedSave) {
    if (!hosted() || !gameSlug) return;
    pendingSave = encodedSave;
    setSync('saving');
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => {
      cloudTimer = null;
      const p = pendingSave; pendingSave = null;
      if (p !== null) pushCloudSave(p, false);
    }, 2000);
    if (cloudTimer.unref) cloudTimer.unref();
  }
  let pendingSave = null;

  function installCloudFlush() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const flush = () => {
      if (!cloudTimer) return;
      clearTimeout(cloudTimer);
      cloudTimer = null;
      const p = pendingSave; pendingSave = null;
      if (p !== null) pushCloudSave(p, true);
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }
  if (token) installCloudFlush();

  /**
   * Load the remote slot; on success return the checksummed encoded save
   * string (caller decodes/adopts). 404 / malformed / offline → null.
   */
  async function cloudLoad() {
    if (!hosted() || !gameSlug) return null;
    try {
      const res = await fetchApi('/me/cloud-saves/' + encodeURIComponent(gameSlug));
      if (res.status === 404) { setSync('synced'); return null; }
      if (!res.ok) { setSync('offline'); return null; }
      const zipBytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(unzipFirstEntry(zipBytes));
      if (!text || text.indexOf('.') < 0) return null;   // not a save doc
      setSync('synced');
      return text;
    } catch (_) {
      setSync('offline');
      return null;
    }
  }

  /** Boot handshake for hosted mode: profile first, then the remote save doc. */
  async function initHosted() {
    if (!hosted()) return null;
    try { await fetchProfile(); } catch (_) { /* nickname falls back to Player id8 */ }
    return cloudLoad();
  }

  // ---- leaderboards (read-only on the platform) -----------------------------------

  /**
   * Read-only platform board: games/{slug} → leaderboardId → entries, with
   * nicknames resolved via the profile helper. Null offline / no board.
   */
  async function fetchPlatformLeaderboard(opts) {
    opts = opts || {};
    if (!hosted() || !gameSlug) return null;
    try {
      const g = await fetchApi('/games/' + encodeURIComponent(gameSlug));
      if (!g.ok) return null;
      const info = await g.json();
      const leaderboardId = info && info.leaderboardId ? info.leaderboardId : null;
      const base = { me: info && info.me ? info.me : null, leaderboardId: leaderboardId, entries: [] };
      if (!leaderboardId) return base;
      const qs = '?friendsOnly=' + (opts.friendsOnly ? 'true' : '') +
        '&page=' + (opts.page || 0) + '&pageSize=' + (opts.pageSize || 20);
      const e = await fetchApi('/leaderboards/' + encodeURIComponent(leaderboardId) + '/entries' + qs);
      if (!e.ok) return base;
      const data = await e.json();
      const rows = Array.isArray(data) ? data : (data && data.entries) || [];
      for (const r of rows) {
        const userId = r && (r.userId || r.playerId) ? (r.userId || r.playerId) : null;
        base.entries.push({
          userId: userId,
          name: userId ? await profileFor(userId) : (r && r.name) || 'Player',
          score: r && typeof r.score === 'number' ? r.score : 0,
          rank: r && r.rank ? r.rank : null,
          you: !!userId && userId === sub
        });
      }
      return base;
    } catch (_) {
      return null;
    }
  }

  // ---- dev-server hosted sessions + leaderboard (NEVER called in hosted mode) ----
  // These are the repo's own server.js routes (local dev only); on-platform they
  // do not exist, so hosted mode guards every entry point below.

  function hostedGuard() {
    return hosted() ? { ok: false, error: 'dev-server-only' } : null;
  }

  async function createHosted(opts) {
    const g = hostedGuard(); if (g) return g;
    return fetchJson('/session', { method: 'POST', body: opts || {} }, 1);
  }
  async function joinHosted(code, name) {
    const g = hostedGuard(); if (g) return g;
    return fetchJson('/session/' + encodeURIComponent(code) + '/join', { method: 'POST', body: { name: name } }, 1);
  }
  async function sessionSnapshot(code, playerToken) {
    const g = hostedGuard(); if (g) return g;
    const q = playerToken ? '?token=' + encodeURIComponent(playerToken) : '';
    return fetchJson('/session/' + encodeURIComponent(code) + q, {}, 0);
  }
  async function sendCommand(code, playerToken, cmd) {
    const g = hostedGuard(); if (g) return g;
    return fetchJson('/session/' + encodeURIComponent(code) + '/command',
      { method: 'POST', body: { token: playerToken, command: cmd } }, 0);
  }
  async function submitScore(entry) {
    const g = hostedGuard(); if (g) return g;
    return fetchJson('/leaderboard', { method: 'POST', body: entry }, 1);
  }
  async function leaderboard(board) {
    const g = hostedGuard(); if (g) return g;
    return fetchJson('/leaderboard?board=' + encodeURIComponent(board || 'global'), {}, 1);
  }

  return {
    now: now, syncTime: syncTime, isOnline: isOnline,
    hosted: hosted, sub: sub, gameSlug: gameSlug,
    get token() { return liveToken.token; },
    displayName: displayName, fetchProfile: fetchProfile, profileFor: profileFor,
    onSync: function (fn) { onSync = fn; },
    getSyncStatus: getSyncStatus,
    queueCloudSave: queueCloudSave, pushCloudSave: pushCloudSave, cloudLoad: cloudLoad,
    initHosted: initHosted,
    fetchPlatformLeaderboard: fetchPlatformLeaderboard,
    createHosted: createHosted, joinHosted: joinHosted,
    sessionSnapshot: sessionSnapshot, sendCommand: sendCommand,
    submitScore: submitScore, leaderboard: leaderboard,
    _fetchJson: fetchJson, _zip: { zipStore: zipStore, unzipFirstEntry: unzipFirstEntry, bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes },
    _readLaunchToken: readLaunchToken, _decodeJwt: decodeJwtPayload, _refreshToken: refreshToken
  };
});
