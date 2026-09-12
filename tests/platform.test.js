'use strict';

/* Platform adapter unit tests (node jest, mocked fetch/location). */

function b64urlJson(obj) {
  const s = Buffer.from(JSON.stringify(obj)).toString('base64');
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(claims) {
  return 'eyJhbGciOiJub25lIn0.' + b64urlJson(claims) + '.sig';
}

// Strict stored-zip verification: EOCD -> central directory -> local header,
// with CRC + size cross-checks (independent of the implementation's reader).
function crc32ref(bytes) {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function strictVerifyZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  expect(dv.getUint16(eocd + 8, true)).toBe(1);   // entries on this disk
  expect(dv.getUint16(eocd + 10, true)).toBe(1);  // total entries
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  expect(cdOff + cdSize).toBe(eocd);              // CD ends right before EOCD
  expect(dv.getUint32(cdOff, true)).toBe(0x02014b50);
  const cdNameLen = dv.getUint16(cdOff + 28, true);
  const localOff = dv.getUint32(cdOff + 42, true); // local-header offset from CD
  expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
  const lNameLen = dv.getUint16(localOff + 26, true);
  const lExtraLen = dv.getUint16(localOff + 28, true);
  const cdCrc = dv.getUint32(cdOff + 16, true);
  const cdSizeRaw = dv.getUint32(cdOff + 20, true);
  expect(dv.getUint32(localOff + 14, true)).toBe(cdCrc);
  expect(dv.getUint32(localOff + 18, true)).toBe(cdSizeRaw);
  const dataOff = localOff + 30 + lNameLen + lExtraLen;
  const data = bytes.slice(dataOff, dataOff + cdSizeRaw);
  expect(crc32ref(data)).toBe(cdCrc);
  const name = new TextDecoder().decode(bytes.slice(localOff + 30, localOff + 30 + lNameLen));
  const cdName = new TextDecoder().decode(bytes.slice(cdOff + 46, cdOff + 46 + cdNameLen));
  expect(cdName).toBe(name);
  return { name: name, data: data };
}

describe('platform adapter', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test('fragment #game_token is read once and stripped; sub/game_scope decoded', () => {
    const replaced = [];
    const jwt = makeJwt({ sub: 'user-abc-1234567890', game_scope: 'spot-kick', exp: 1 });
    global.location = {
      hash: '#game_token=' + jwt + '&session_id=zzz',
      search: '',
      pathname: '/index.html'
    };
    global.history = { replaceState: (a, b, url) => replaced.push(url) };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    expect(platform.token).toBe(jwt);
    expect(platform.sub).toBe('user-abc-1234567890');
    expect(platform.gameSlug).toBe('spot-kick');
    expect(platform.hosted()).toBe(true);
    expect(replaced.length).toBe(1);
    expect(replaced[0]).toBe('/index.html'); // token + session_id stripped
    delete global.location;
    delete global.history;
  });

  test('query-param token works as local-dev fallback and is stripped', () => {
    const replaced = [];
    const jwt = makeJwt({ sub: 'dev-user', game_scope: 'spot-kick' });
    global.location = { hash: '', search: '?token=' + jwt, pathname: '/' };
    global.history = { replaceState: (a, b, url) => replaced.push(url) };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    expect(platform.token).toBe(jwt);
    expect(replaced[0]).toBe('/' );
    delete global.location;
    delete global.history;
  });

  test('no token offline: hosted() false, displayName null', () => {
    const platform = require('../js/platform');
    expect(platform.hosted()).toBe(false);
    expect(platform.displayName()).toBeNull();
  });

  test('fetchJson sends Authorization: Bearer on every call when hosted', async () => {
    const jwt = makeJwt({ sub: 'u1', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ now: 5 })
    });
    await platform.syncTime();
    expect(mock).toHaveBeenCalled();
    const url = mock.mock.calls[0][0];
    const headers = mock.mock.calls[0][1].headers;
    expect(url).toBe('/api/v1/time');
    expect(headers.Authorization).toBe('Bearer ' + jwt);
    delete global.location;
    delete global.history;
  });

  test('refresh swaps the token via POST games/{slug}/launch-token; failure retries', async () => {
    jest.useFakeTimers();
    try {
      const jwt = makeJwt({ sub: 'u1', game_scope: 'spot-kick' });
      global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
      global.history = { replaceState: () => {} };
      let platform;
      jest.isolateModules(() => { platform = require('../js/platform'); });
      const mock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ token: 'refreshed-token' })
      });
      await platform._refreshToken();
      expect(mock).toHaveBeenCalledWith('/api/v1/games/spot-kick/launch-token',
        expect.objectContaining({ method: 'POST' }));
      expect(platform.token).toBe('refreshed-token');
      // failure path reschedules a retry in ~60 s
      mock.mockResolvedValue({ ok: false, status: 500 });
      await platform._refreshToken();
      expect(platform.token).toBe('refreshed-token'); // unchanged
      const before = jest.getTimerCount();
      expect(before).toBeGreaterThan(0);
      delete global.location;
      delete global.history;
    } finally {
      jest.useRealTimers();
    }
  });

  test('profileFor uses the nickname, never the username, with Player-id8 fallback', async () => {
    const jwt = makeJwt({ sub: 'user-abcdef123456', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'user-abcdef123456', username: 'realUsername', nickname: 'FloodlightFan' })
    });
    const name = await platform.profileFor('user-abcdef123456');
    expect(name).toBe('FloodlightFan');
    expect(mock.mock.calls[0][0]).toBe('/api/v1/users/user-abcdef123456/profile');
    // cached: no second fetch
    await platform.profileFor('user-abcdef123456');
    expect(mock).toHaveBeenCalledTimes(1);
    // fallback when 404 / missing nickname
    mock.mockResolvedValue({ ok: false, status: 404 });
    const fb = await platform.profileFor('user-zzz999');
    expect(fb).toBe('Player user-zzz');
    delete global.location;
    delete global.history;
  });

  test('cloud push produces a strict-valid stored zip of the save doc', async () => {
    const jwt = makeJwt({ sub: 'u1', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    let captured = null;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      captured = { url: url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200 };
    });
    const saveDoc = JSON.stringify({ v: 1, at: 1, data: { journeyDone: ['s1'], stats: { wins: 2 } } }) + '.checksum';
    await platform.pushCloudSave(saveDoc, false);
    expect(captured.url).toBe('/api/v1/me/cloud-saves/spot-kick');
    const zipBytes = platform._zip.base64ToBytes(captured.body.dataBase64);
    const entry = strictVerifyZip(zipBytes);
    expect(entry.name).toBe('save.json');
    expect(new TextDecoder().decode(entry.data)).toBe(saveDoc);
    // status visible
    expect(platform.getSyncStatus()).toBe('synced');
    delete global.location;
    delete global.history;
  });

  test('cloudLoad adopts a remote doc and returns null on 404/malformed', async () => {
    const jwt = makeJwt({ sub: 'u1', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    const saveDoc = JSON.stringify({ v: 1, at: 2, data: { streak: 4 } }) + '.deadbeef';
    const zip = platform._zip.zipStore('save.json', new TextEncoder().encode(saveDoc));
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
    });
    const remote = await platform.cloudLoad();
    expect(remote).toBe(saveDoc);
    // 404 → null (first slot)
    mock.mockResolvedValue({ ok: false, status: 404 });
    expect(await platform.cloudLoad()).toBeNull();
    // malformed body → null, never throws
    mock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    expect(await platform.cloudLoad()).toBeNull();
    delete global.location;
    delete global.history;
  });

  test('dev-server session/leaderboard routes are guarded in hosted mode', async () => {
    const jwt = makeJwt({ sub: 'u1', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    const mock = jest.spyOn(global, 'fetch'); // never called
    for (const fn of [
      () => platform.createHosted({}),
      () => platform.joinHosted('ABCDE'),
      () => platform.sessionSnapshot('ABCDE', 'tok'),
      () => platform.sendCommand('ABCDE', 'tok', {}),
      () => platform.submitScore({}),
      () => platform.leaderboard('global')
    ]) {
      const res = await fn();
      expect(res.ok).toBe(false);
      expect(res.error).toBe('dev-server-only');
    }
    expect(mock).not.toHaveBeenCalled();
    delete global.location;
    delete global.history;
  });

  test('fetchPlatformLeaderboard reads games/{slug} then entries, resolving nicknames', async () => {
    const jwt = makeJwt({ sub: 'me-12345678', game_scope: 'spot-kick' });
    global.location = { hash: '#game_token=' + jwt, search: '', pathname: '/' };
    global.history = { replaceState: () => {} };
    let platform;
    jest.isolateModules(() => { platform = require('../js/platform'); });
    const routes = {
      '/api/v1/games/spot-kick': { ok: true, status: 200, json: async () => ({ leaderboardId: 'lb-1', me: { score: 3 } }) },
      '/api/v1/leaderboards/lb-1/entries?friendsOnly=true&page=0&pageSize=20':
        { ok: true, status: 200, json: async () => ({ entries: [{ userId: 'me-12345678', score: 3, rank: 2 }, { userId: 'x-1', score: 9, rank: 1 }] }) },
      '/api/v1/users/me-12345678/profile': { ok: true, status: 200, json: async () => ({ nickname: 'MeNick' }) },
      '/api/v1/users/x-1/profile': { ok: true, status: 200, json: async () => ({ nickname: 'RivalNick' }) }
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const r = routes[url];
      if (!r) return { ok: false, status: 404 };
      return r;
    });
    const board = await platform.fetchPlatformLeaderboard({ friendsOnly: true });
    expect(board.leaderboardId).toBe('lb-1');
    expect(board.entries.length).toBe(2);
    expect(board.entries[0].name).toBe('MeNick');
    expect(board.entries[0].you).toBe(true);
    expect(board.entries[1].name).toBe('RivalNick');
    expect(board.entries[1].you).toBe(false);
    expect(board.me.score).toBe(3);
    delete global.location;
    delete global.history;
  });
});
