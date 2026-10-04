'use strict';

/*
 * Spot Kick platform adapter.
 *
 * Standalone (no token): no network at all — no own-server calls, local
 * clock, local records. Guest play works fully offline; no tokens are ever
 * persisted.
 *
 * Hosted mode (StarHermit platform): window.StarHermit (starhermit-sdk.js,
 * loaded first) reads the launch token (#game_token / #access_token, then
 * stripped), takes the slug from game_scope and renews the token. Through
 * the SDK this adapter provides the account nickname, the cloud-save mirror
 * (slot game:<slug>; remote wins on load, localStorage stays the offline
 * cache), the settings KV, keyboard bindings (control.* in starhermit.txt),
 * read-only platform leaderboards, sign-in and the invite link; realtime
 * rooms (js/net.js) use fetchJson with the SDK's live token; GET /api/v1/time
 * syncs the clock. The repo's own session and leaderboard routes are never
 * called.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {

  const BASE = '/api/v1';
  let timeOffset = 0;         // serverNow - clientNow
  let timeSynced = false;
  let online = true;

  function now() { return Date.now() + (timeSynced ? timeOffset : 0); }

  const SH = () => (root && root.StarHermit) || globalThis.StarHermit || null;
  const sdk = SH();
  if (sdk && !sdk.token) sdk.init();

  function hosted() { const sh = SH(); return !!(sh && sh.signedIn); }
  function liveToken() { const sh = SH(); return sh ? sh.token : null; }

  // Keyboard actions; mirrors the control.* lines in starhermit.txt.
  const DEFAULT_CONTROLS = {
    left: ['ArrowLeft'], right: ['ArrowRight'], high: ['ArrowUp'], low: ['ArrowDown'],
    confirm: ['Enter', 'Space'], pause: ['Escape'], help: ['KeyH'],
    curveLeft: ['KeyQ'], curveRight: ['KeyE'],
    early: ['Digit1', 'Numpad1'], onTime: ['Digit2', 'Numpad2'], late: ['Digit3', 'Numpad3'],
    undo: ['KeyU'], camera: ['KeyC'], skip: ['KeyS']
  };
  // Settings mirrored to the platform settings KV.
  const SYNCED_SETTINGS = ['music', 'sfx', 'ambience', 'voice', 'gfx', 'theme', 'reducedMotion', 'highContrast',
    'largeText', 'leftHanded', 'timingAssist', 'hapticsOff', 'captions', 'cameraPref', 'tutorialDone'];
  let controls = cloneControls(DEFAULT_CONTROLS);
  function cloneControls(c) {
    const out = {};
    Object.keys(c).forEach(function (k) { out[k] = c[k].slice(); });
    return out;
  }

  // ---- REST helper -------------------------------------------------------------

  async function fetchJson(path, opts, retries) {
    opts = opts || {};
    retries = retries === undefined ? 2 : retries;
    const init = { method: opts.method || 'GET', headers: {} };
    if (liveToken()) init.headers['Authorization'] = 'Bearer ' + liveToken();
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
    if (liveToken()) headers['Authorization'] = 'Bearer ' + liveToken();
    return fetch(BASE + path, Object.assign({}, opts, { headers: headers }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Platform time (signed in only); standalone keeps the local clock.
  async function syncTime() {
    if (!hosted()) return false;
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

  function isOnline() { return online; }

  // ---- account identity ---------------------------------------------------------

  let nickname = null;

  /** Resolve a user id to a display nickname ("Player "+id prefix fallback). */
  async function profileFor(userId) {
    const p = hosted() ? await SH().profile(String(userId)).catch(function () { return null; }) : null;
    return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
  }

  /** Load the signed-in player's nickname into the identity slot. */
  async function fetchProfile() {
    if (!hosted()) return null;
    nickname = await profileFor(SH().userId);
    return nickname;
  }

  function displayName() {
    if (!hosted()) return null;
    return nickname || ('Player ' + String(SH().userId).slice(0, 6));
  }

  // ---- cloud save (slot game:<slug> via the SDK; localStorage stays the cache) ----

  let syncStatus = 'offline';           // offline | saving | synced
  let onSync = null;                    // fn(status)
  let onSignedOut = null;               // fn()

  function setSync(status) {
    if (syncStatus === status) return;
    syncStatus = status;
    if (onSync) onSync(status);
  }

  function getSyncStatus() { return syncStatus; }

  /** Mirror the checksummed local save doc (encoded string) to the cloud slot now. */
  async function pushCloudSave(encodedSave, keepalive) {
    if (!hosted()) return;
    const ok = await SH().writeSave(encodedSave, { keepalive: !!keepalive });
    setSync(ok ? 'synced' : 'offline');
  }

  // Debounced mirror (~2 s); flushed on pagehide / hidden visibilitychange.
  let saveTimer = null, pendingSave = null;
  function queueCloudSave(encodedSave) {
    if (!hosted()) return;
    pendingSave = encodedSave;
    setSync('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flushCloudSave(false); }, 2000);
    if (saveTimer && saveTimer.unref) saveTimer.unref();
  }
  function flushCloudSave(keepalive) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const p = pendingSave; pendingSave = null;
    return p !== null ? pushCloudSave(p, keepalive) : Promise.resolve();
  }

  if (sdk) {
    sdk.on('auth', function (a) {
      if (a.signedIn) return;
      nickname = null;
      setSync('offline');
      if (onSignedOut) { try { onSignedOut(); } catch (_) { /* UI hook */ } }
    });
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', function () { flushCloudSave(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushCloudSave(true); });
  }

  /**
   * Load the remote slot; on success return the checksummed encoded save
   * string (caller decodes/adopts). None / malformed / offline → null.
   */
  async function cloudLoad() {
    if (!hosted()) return null;
    const text = await SH().loadSave().catch(function () { return null; });
    setSync('synced');
    if (!text || text.indexOf('.') < 0) return null;   // not a save doc
    return text;
  }

  /** Boot handshake for hosted mode: profile, bindings, then the remote save doc. */
  async function initHosted() {
    if (!hosted()) return null;
    await fetchProfile();
    await loadControls();
    return cloudLoad();
  }

  // ---- settings KV + keyboard bindings --------------------------------------------

  /** The player's platform settings (preference keys only; {} standalone). */
  async function loadSettings() {
    if (!hosted()) return {};
    const remote = await SH().getSettings().catch(function () { return {}; });
    const out = {};
    SYNCED_SETTINGS.forEach(function (k) { if (remote && remote[k] !== undefined && remote[k] !== null) out[k] = remote[k]; });
    return out;
  }
  /** Mirror preferences to the platform settings KV (no-op standalone). */
  function pushSettings(settings) {
    if (!hosted()) return;
    const patch = {};
    SYNCED_SETTINGS.forEach(function (k) { if (settings[k] !== undefined) patch[k] = settings[k]; });
    SH().patchSettings(patch);
  }
  async function loadControls() {
    if (hosted()) controls = await SH().loadBindings(DEFAULT_CONTROLS).catch(function () { return controls; });
    return controls;
  }
  function actionFor(code) {
    for (const a of Object.keys(controls)) if (controls[a].indexOf(code) !== -1) return a;
    return null;
  }
  function keyLabel(action) {
    const NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
    return (controls[action] || []).filter(function (c) { return !/^Numpad\d$/.test(c); })
      .map(function (c) { return NAMES[c] || c.replace(/^Key|^Digit/, ''); }).join('/');
  }

  // ---- leaderboards (read-only on the platform) -----------------------------------

  /**
   * Read-only platform board: games/{slug} → leaderboardId → entries, with
   * nicknames resolved via the profile helper. Null offline / no board.
   */
  async function fetchPlatformLeaderboard(opts) {
    opts = opts || {};
    if (!hosted()) return null;
    try {
      const sh = SH();
      const boards = await sh.leaderboards();
      const board = (boards || [])[0] || null;
      const base = { me: null, leaderboardId: board ? board.id : null, entries: [] };
      if (!board) return base;
      const data = await sh.leaderboardEntries(board.id, {
        page: (opts.page || 0) + 1, pageSize: opts.pageSize || 20, scope: opts.friendsOnly ? 'friends' : undefined
      });
      for (const r of (data && data.items) || []) {
        const userId = r && r.userId ? r.userId : null;
        base.entries.push({
          userId: userId,
          name: userId ? await profileFor(userId) : 'Player',
          score: r && typeof r.score === 'number' ? r.score : 0,
          rank: r && r.rank ? r.rank : null,
          you: !!userId && userId === sh.userId
        });
      }
      return base;
    } catch (_) {
      return null;
    }
  }

  return {
    now: now, syncTime: syncTime, isOnline: isOnline,
    hosted: hosted,
    get sub() { const sh = SH(); return hosted() ? sh.userId : null; },
    get gameSlug() { const sh = SH(); return sh ? sh.slug : null; },
    get token() { return liveToken(); },
    displayName: displayName, fetchProfile: fetchProfile, profileFor: profileFor,
    onSync: function (fn) { onSync = fn; },
    onSignedOut: function (fn) { onSignedOut = fn; },
    getSyncStatus: getSyncStatus,
    queueCloudSave: queueCloudSave, pushCloudSave: pushCloudSave, flushCloudSave: flushCloudSave, cloudLoad: cloudLoad,
    initHosted: initHosted,
    loadSettings: loadSettings, pushSettings: pushSettings,
    loadControls: loadControls, actionFor: actionFor, keyLabel: keyLabel, DEFAULT_CONTROLS: DEFAULT_CONTROLS,
    canSignIn: function () { const sh = SH(); return !!(sh && sh.canSignIn()); },
    signIn: function () { const sh = SH(); return !!(sh && sh.signIn()); },
    inviteLink: function () { return hosted() ? SH().inviteLink() : null; },
    fetchPlatformLeaderboard: fetchPlatformLeaderboard,
    _fetchJson: fetchJson
  };
});
