'use strict';

/* Platform adapter unit tests (jest): js/platform.js over the shipped
 * StarHermit SDK with a stubbed fetch and launch fragment — token read/strip,
 * profile nickname, cloud-save round-trip on game:<slug>, settings KV patch,
 * key bindings, read-only board, dev-route guards, sign-out, and no network
 * at all standalone. */

const SDK = require('../starhermit-sdk.js');

const USER = 'user-abc-1234567890';
const SLUG = 'spot-kick-test';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = b64u({ alg: 'none' }) + '.' + b64u({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

function res(status, body) {
  const bytes = body instanceof Uint8Array ? body : null;
  const text = bytes || body == null ? '' : JSON.stringify(body);
  return {
    status, ok: status >= 200 && status < 300, statusText: String(status),
    text: async () => text, json: async () => JSON.parse(text || 'null'),
    arrayBuffer: async () => (bytes || Buffer.from(text)).slice().buffer
  };
}
function win(hash, hostname = 'localhost') {
  return {
    location: { hash, search: '', pathname: '/index.html', hostname, href: 'http://' + hostname + '/index.html' + hash },
    history: { state: null, replaceState(_s, _t, url) { this.last = url; } }
  };
}
function loadPlatform(sh) {
  global.StarHermit = sh;
  let platform;
  jest.isolateModules(() => { platform = require('../js/platform'); });
  return platform;
}

describe('platform adapter over the StarHermit SDK', () => {
  afterEach(() => { delete global.StarHermit; delete global.fetch; });

  test('hosted: token, nickname, cloud save, settings, bindings, board, sign-out', async () => {
    const calls = [];
    let save = null;
    const kv = { theme: 'dawn', junk: 1 };
    const fetch = async (url, init = {}) => {
      const method = init.method || 'GET', path = url.split('?')[0];
      calls.push({ url, method, auth: init.headers.Authorization, body: init.body, keepalive: init.keepalive });
      if (path === `/api/v1/users/${USER}/profile`) return res(200, { username: 'kicker_u', nickname: 'Keeper' });
      if (path === '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG)) {
        if (method === 'PUT') { save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(200, { etag: '"v' + calls.length + '"' }); }
        return save ? res(200, new Uint8Array(save)) : res(404);
      }
      if (path === `/api/v1/games/${SLUG}/settings`) {
        if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
        return res(200, { settings: kv });
      }
      if (path === `/api/v1/games/${SLUG}/controls`) return res(200, { actions: [{ action: 'skip', codes: ['KeyX'] }] });
      if (path === `/api/v1/games/${SLUG}/leaderboards`) return res(200, [{ id: 'lb', key: 'wins' }]);
      if (path === '/api/v1/leaderboards/lb/entries') return res(200, { items: [{ userId: USER, score: 9, rank: 1 }] });
      return res(404);
    };
    const w = win('#game_token=' + TOKEN + '&session_id=zzz');
    const sh = SDK.create({ window: w, fetch, setTimeout: () => 0, clearTimeout() {} });
    sh.init();
    global.fetch = fetch; // rooms REST (js/net.js) goes through fetchJson
    const p = loadPlatform(sh);
    expect(w.history.last).toBe('/index.html');
    expect(p.hosted()).toBe(true);
    expect(p.token).toBe(TOKEN);
    expect(p.sub).toBe(USER);
    expect(p.gameSlug).toBe(SLUG);

    expect(await p.initHosted()).toBeNull();
    expect(p.displayName()).toBe('Keeper');
    expect(p.actionFor('KeyX')).toBe('skip');
    expect(p.actionFor('KeyS')).toBeNull();
    expect(p.actionFor('Digit2')).toBe('onTime');
    expect(p.keyLabel('early')).toBe('1');

    p.queueCloudSave('payload.checksum');
    expect(p.getSyncStatus()).toBe('saving');
    await p.flushCloudSave(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url.endsWith('/cloud-saves/game%3A' + SLUG)).toBe(true);
    expect(put.keepalive).toBe(true);
    expect(p.getSyncStatus()).toBe('synced');
    expect(await p.cloudLoad()).toBe('payload.checksum');

    expect(await p.loadSettings()).toEqual({ theme: 'dawn' });
    p.pushSettings({ music: 20, largeText: true, internal: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.music).toBe(20);
    expect(kv.internal).toBeUndefined();

    const board = await p.fetchPlatformLeaderboard({ pageSize: 10 });
    expect(board.entries).toEqual([{ userId: USER, name: 'Keeper', score: 9, rank: 1, you: true }]);

    const r = await p._fetchJson('/realtime/rooms/mine', {}, 0);
    expect(r.ok).toBe(false);
    const rooms = calls.find((c) => c.url === '/api/v1/realtime/rooms/mine');
    expect(rooms.auth).toBe('Bearer ' + TOKEN);
    expect(calls.every((c) => c.auth === 'Bearer ' + TOKEN)).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/me')).toBe(false);

    expect(p.inviteLink().endsWith(`/game-invite/${USER}/${SLUG}`)).toBe(true);
    expect(p.canSignIn()).toBe(false);
    let out = 0;
    p.onSignedOut(() => out++);
    sh.signOut('expired');
    expect(out).toBe(1);
    expect(p.hosted()).toBe(false);
    expect(p.inviteLink()).toBeNull();
  });

  test('standalone: no platform fetch', async () => {
    const sdkCalls = [];
    const sh = SDK.create({ window: win(''), fetch: async (u) => { sdkCalls.push(u); return res(500); } });
    sh.init();
    global.fetch = jest.fn(async () => res(500));
    const p = loadPlatform(sh);
    expect(p.hosted()).toBe(false);
    expect(p.displayName()).toBeNull();
    expect(await p.initHosted()).toBeNull();
    p.queueCloudSave('x.y');
    await p.flushCloudSave(true);
    expect(await p.cloudLoad()).toBeNull();
    expect(await p.loadSettings()).toEqual({});
    p.pushSettings({ music: 1 });
    await p.loadControls();
    expect(await p.fetchPlatformLeaderboard()).toBeNull();
    expect(p.actionFor('Escape')).toBe('pause');
    expect(p.canSignIn()).toBe(false);
    expect(await p.syncTime()).toBe(false); // no own-server /time probe standalone
    expect(p.createHosted).toBeUndefined(); // dev-server session/leaderboard client removed
    expect(sdkCalls).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('on <id>.starhermit.com without a token: sign-in offered', () => {
    // canSignIn() is only true on a game's UUID host (<uuid>.starhermit.com).
    const sh = SDK.create({ window: win('', '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com'), fetch: async () => res(500) });
    sh.init();
    expect(loadPlatform(sh).canSignIn()).toBe(true);
  });
});

describe('rooms reconnect renews the launch token first', () => {
  const TOKEN2 = b64u({ alg: 'none' }) + '.' + b64u({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 7200 }) + '.sig';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let sockets;
  class MockWS {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen && this.onopen(); }); }
    send() {}
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1006 }); }
  }
  afterEach(() => { delete global.StarHermit; delete global.fetch; delete global.WebSocket; delete global.location; });

  async function hostedRoom(renewStatus, renewBody, mine) {
    sockets = [];
    const calls = [];
    const sdkFetch = async (url, init = {}) => {
      calls.push(url);
      if (url.endsWith('/launch-token')) return res(renewStatus, renewBody);
      return res(404);
    };
    global.fetch = async (url, init = {}) => {
      calls.push(url);
      if (url === '/api/v1/realtime/rooms' && init.method === 'POST') return res(200, { id: 'room-1' });
      if (url === '/api/v1/realtime/rooms/room-1/open') return res(200, {});
      if (url === '/api/v1/realtime/rooms/mine') return mine ? mine() : res(200, { roomId: 'room-1' });
      return res(404);
    };
    global.WebSocket = MockWS;
    global.location = { protocol: 'https:', host: 'spot-kick.starhermit.com' };
    const sh = SDK.create({ window: win('#game_token=' + TOKEN), fetch: sdkFetch, setTimeout: () => 0, clearTimeout() {} });
    sh.init();
    const p = loadPlatform(sh);
    const { RoomsClient } = require('../js/net.js');
    const events = [];
    const c = new RoomsClient(p, { rules: {}, session: {}, onEvent: (op) => events.push(op) });
    await c.createRoom();
    return { p, c, calls, events, first: sockets[0] };
  }

  test('reconnect renews first and reopens with the new token', async () => {
    const { c, calls, first } = await hostedRoom(200, { token: TOKEN2 });
    expect(first.url).toContain('access_token=' + encodeURIComponent(TOKEN));
    first.close();
    await wait(700);
    const renewAt = calls.findIndex((u) => u.endsWith('/launch-token'));
    const mineAt = calls.indexOf('/api/v1/realtime/rooms/mine');
    expect(renewAt).toBeGreaterThanOrEqual(0);
    expect(mineAt).toBeGreaterThan(renewAt);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('access_token=' + encodeURIComponent(TOKEN2));
    c.leave();
  });

  test("'retry' backs off without reopening the old URL", async () => {
    const { c, calls, first } = await hostedRoom(503, null);
    first.close();
    await wait(700);
    expect(calls.filter((u) => u.endsWith('/launch-token'))).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(calls).not.toContain('/api/v1/realtime/rooms/mine');
    expect(c.roomId).toBe('room-1');
    await wait(1100); // second backoff (1 s): renews again, still no reopen
    expect(calls.filter((u) => u.endsWith('/launch-token'))).toHaveLength(2);
    expect(sockets).toHaveLength(1);
    c.leave();
  });

  test("'relaunch' stops reconnecting and surfaces auth-lost", async () => {
    const { p, c, events, first } = await hostedRoom(401, null);
    first.close();
    await wait(700);
    expect(events).toContain('auth-lost');
    expect(c.roomId).toBeNull();
    expect(p.hosted()).toBe(false);
    expect(typeof p.relaunch).toBe('function');
    await wait(1200);
    expect(sockets).toHaveLength(1);
  });

  test("'terms-required' stops reconnecting like auth loss and surfaces terms-required", async () => {
    const { c, events, first } = await hostedRoom(403, { error: 'terms_acceptance_required' });
    first.close();
    await wait(700);
    expect(events).toContain('terms-required');
    expect(events).not.toContain('auth-lost');
    expect(c.roomId).toBeNull();
    await wait(1200);
    expect(sockets).toHaveLength(1);
  });

  test('a room that no longer exists ends the reconnect loop with unavailable', async () => {
    const { c, calls, events, first } = await hostedRoom(200, { token: TOKEN2 }, () => res(404, { error: 'not_found' }));
    first.close();
    await wait(700);
    expect(calls).toContain('/api/v1/realtime/rooms/mine');
    expect(events).toContain('unavailable');
    expect(c.roomId).toBeNull();
    await wait(1200);
    expect(sockets).toHaveLength(1);
    expect(events.filter((e) => e === 'disconnected')).toHaveLength(0);
  });

  test('session-expired strings exist in every locale', () => {
    const { STRINGS } = require('../js/sh-strings.js');
    for (const [loc, t] of Object.entries(STRINGS)) {
      for (const k of ['expiredTitle', 'expiredBody', 'termsTitle', 'termsBody', 'relaunch', 'playLocal']) expect([loc, k, !!t[k]]).toEqual([loc, k, true]);
    }
  });
});

describe('cloud-save conflicts merge instead of overwriting', () => {
  afterEach(() => { delete global.StarHermit; });

  test('mergeSaves keeps both devices\' progress', () => {
    global.self = global;
    const ui = require('../js/ui.js');
    const m = ui.mergeSaves(
      { journeyDone: ['j01', 'j02'], achievements: { first_win: 20 }, dailyResults: { '2026-10-01': { won: true, score: '3–1' } },
        streak: 1, bestStreak: 4, stats: { goals: 10, saves: 2, curvedGoals: 1, wins: 3, matches: 6, dailies: 1 } },
      { journeyDone: ['j01', 'j03'], achievements: { first_win: 10, keeper_10: 30 }, dailyResults: { '2026-10-02': { won: false, score: '1–2' } },
        streak: 3, bestStreak: 3, stats: { goals: 7, saves: 9, curvedGoals: 0, wins: 4, matches: 5, dailies: 2 } });
    expect(m.journeyDone).toEqual(['j01', 'j02', 'j03']);
    expect(m.achievements).toEqual({ first_win: 10, keeper_10: 30 });
    expect(Object.keys(m.dailyResults).sort()).toEqual(['2026-10-01', '2026-10-02']);
    expect([m.streak, m.bestStreak]).toEqual([3, 4]);
    expect(m.stats).toEqual({ goals: 10, saves: 9, curvedGoals: 1, wins: 4, matches: 6, dailies: 2 });
  });

  test('a write refused with 412 reloads the cloud doc and hands it to the game', async () => {
    const slot = '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG);
    const zipOf = async (text) => {
      let bytes = null;
      const z = SDK.create({ window: win('#game_token=' + TOKEN), fetch: async (u, init = {}) => {
        if (init.method === 'PUT') { bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(200, { etag: '"z"' }); }
        return res(404);
      }, setTimeout: () => 0, clearTimeout() {} });
      z.init();
      await z.writeSave(text);
      return bytes;
    };
    let stored = null, etag = null;
    const puts = [];
    const fetch = async (url, init = {}) => {
      const method = init.method || 'GET', path = url.split('?')[0];
      if (path === slot + '/info') return res(200, { exists: !!stored, etag });
      if (path === slot && method === 'GET') return res(200, new Uint8Array(stored));
      if (path === slot && method === 'PUT') {
        const match = init.headers['If-Match'];
        puts.push(match || init.headers['If-None-Match']);
        if ((match && match !== etag) || (!match && stored)) return res(412, { error: 'precondition_failed' });
        stored = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etag = '"v' + puts.length + '"';
        return res(200, { etag });
      }
      if (path.endsWith('/controls')) return res(200, { actions: [] });
      return res(404);
    };
    const sh = SDK.create({ window: win('#game_token=' + TOKEN), fetch, setTimeout: () => 0, clearTimeout() {} });
    sh.init();
    const p = loadPlatform(sh);
    expect(await p.initHosted()).toBeNull();          // empty slot: later writes are conditional
    const got = new Promise((resolve) => p.onConflict(resolve));
    stored = await zipOf('other-device.save');
    etag = '"other"';
    await p.pushCloudSave('this-device.save');
    expect(await got).toBe('other-device.save');
    expect(sh.saveConflicted()).toBe(false);
    await p.pushCloudSave('merged.save');
    expect(puts[puts.length - 1]).toBe('"other"');
    expect(p.getSyncStatus()).toBe('synced');
  });
});
