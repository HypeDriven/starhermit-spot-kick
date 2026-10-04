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
        if (method === 'PUT') { save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(204); }
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
    const sh = SDK.create({ window: win('', 'spot-kick.starhermit.com'), fetch: async () => res(500) });
    sh.init();
    expect(loadPlatform(sh).canSignIn()).toBe(true);
  });
});
