'use strict';

/*
 * Spot Kick platform — same-origin /api adapter: server-time sync with
 * round-trip offset, retries with backoff, structured {"error":...} handling,
 * hosted session client (create/join/poll/command), leaderboard submission.
 * No tokens are ever persisted; guest play works fully offline.
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

  async function fetchJson(path, opts, retries) {
    opts = opts || {};
    retries = retries === undefined ? 2 : retries;
    const init = { method: opts.method || 'GET', headers: {} };
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

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function syncTime() {
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

  // ---- hosted sessions (authoritative on the server) ----
  async function createHosted(opts) {
    return fetchJson('/session', { method: 'POST', body: opts || {} }, 1);
  }
  async function joinHosted(code, name) {
    return fetchJson('/session/' + encodeURIComponent(code) + '/join', { method: 'POST', body: { name: name } }, 1);
  }
  async function sessionSnapshot(code, playerToken) {
    const q = playerToken ? '?token=' + encodeURIComponent(playerToken) : '';
    return fetchJson('/session/' + encodeURIComponent(code) + q, {}, 0);
  }
  async function sendCommand(code, playerToken, cmd) {
    return fetchJson('/session/' + encodeURIComponent(code) + '/command',
      { method: 'POST', body: { token: playerToken, command: cmd } }, 0);
  }
  async function submitScore(entry) {
    return fetchJson('/leaderboard', { method: 'POST', body: entry }, 1);
  }
  async function leaderboard(board) {
    return fetchJson('/leaderboard?board=' + encodeURIComponent(board || 'global'), {}, 1);
  }

  return {
    now: now, syncTime: syncTime, isOnline: isOnline,
    createHosted: createHosted, joinHosted: joinHosted,
    sessionSnapshot: sessionSnapshot, sendCommand: sendCommand,
    submitScore: submitScore, leaderboard: leaderboard,
    _fetchJson: fetchJson
  };
});
