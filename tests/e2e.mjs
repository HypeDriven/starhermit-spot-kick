/**
 * Spot Kick — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Help overlay → Play (Quick Match, Vs AI) → Start Match →
 *   pause/resume → play the alternating penalty shootout to a real
 *   decision (human shoots and dives via real keyboard/pointer/button
 *   inputs; the deterministic AI opponent acts automatically) → results
 *   screen with score breakdown → persisted guest profile.
 * A second pass runs a shorter load → Play → real play on a mobile
 *   touch viewport (canvas goal-zone tap + buttons via touchscreen.tap).
 *
 * The game exposes its controller via `window.SpotKickDebug = { G, rules,
 * session }` (bootstrap.js). The test reads that handle ONLY to observe
 * round state (phase/shooter/tick/over) and to know when it is the human's
 * turn — the same information the HUD shows. It never calls the game's own
 * move API: every shot/dive is produced by real keyboard presses (zone
 * cursor/confirm), real clicks on the on-screen curve/timing/confirm
 * buttons, or real canvas taps. No game code is modified.
 *
 * Serving: the game is a fully self-contained Three.js SPA and plays
 * offline (platform.syncTime / hosted API simply degrade to the local
 * guest path when the backend is absent — see platform.js). Per test
 * convention this embeds a minimal node:http static server and answers
 * /api/* probes with 200 `{}` so the client stays on its offline path
 * with zero console noise. The repo's authoritative server.js is not used.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/spot-kick-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON so the
    // platform adapter degrades to its offline path without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the exposed controller handle ----------

// Human controls side A; the AI opponent is side B. Read only.
const humanSide = () => 'A';
const keeperOf = (shooter) => (shooter === 'A' ? 'B' : 'A');

const readMatch = (page) => page.evaluate(() => {
  const D = window.SpotKickDebug;
  const g = D && D.G;
  const st = g && g.match && g.match.state;
  if (!st) return null;
  return {
    appState: g.appState, mode: g.mode, over: st.over, winner: st.winner,
    phase: st.phase, shooter: st.shooter, tick: st.tick,
    kicksA: st.kicksA, kicksB: st.kicksB, scoreA: st.scoreA, scoreB: st.scoreB,
    suddenDeath: st.suddenDeath, terminalReason: st.terminalReason,
  };
});

// Wait until the local controller is 'active' AND it is the human's turn
// (either shooting or keeping) AND the matching on-screen panel is shown.
// Resolves to 'shoot' | 'dive' | 'over'.
async function waitHumanTurn(page, timeout = 20000) {
  const h = await page.waitForFunction(() => {
    const D = window.SpotKickDebug;
    const g = D && D.G;
    const st = g && g.match && g.match.state;
    if (!st) return null;
    if (st.over) return 'over';
    if (g.appState !== 'active') return null;
    const keeper = st.shooter === 'A' ? 'B' : 'A';
    const shootPanel = document.getElementById('panel-shoot');
    const divePanel = document.getElementById('panel-dive');
    if (st.phase === 'shooter' && st.shooter === 'A' &&
        shootPanel && !shootPanel.classList.contains('hidden')) return 'shoot';
    if (st.phase === 'keeper' && keeper === 'A' &&
        divePanel && !divePanel.classList.contains('hidden')) return 'dive';
    return null;
  }, null, { timeout });
  return h.jsonValue();
}

// Navigate the game's keyboard zone cursor to (dir, height) with real arrow
// presses, tracking our own view of the cursor across calls.
async function navCursor(page, cur, dir, height) {
  const cols = ['left', 'center', 'right'];
  let ci = cols.indexOf(cur.dir);
  const ti = cols.indexOf(dir);
  while (ci < ti) { await page.keyboard.press('ArrowRight'); ci++; }
  while (ci > ti) { await page.keyboard.press('ArrowLeft'); ci--; }
  if (cur.height !== height) {
    await page.keyboard.press(height === 'high' ? 'ArrowUp' : 'ArrowDown');
  }
  cur.dir = dir; cur.height = height;
}

// One real human action: pick a zone via keyboard, set curve/timing by
// clicking the visible segment buttons, and confirm with the visible button.
async function humanMove(page, phase, move, cur) {
  await navCursor(page, cur, move.dir, move.height);
  await page.keyboard.press('Enter');           // select the zone (onZonePick)
  if (phase === 'shoot') await page.click(`[data-curve="${move.curve}"]`);
  else await page.click(`[data-timing="${move.timing}"]`);
  const btn = phase === 'shoot' ? '#btn-confirm-shot' : '#btn-confirm-dive';
  await page.click(btn);
}

// Project a logical goal-zone center to canvas client coordinates so we can
// really tap a visible zone on the canvas (replicates FRAME + camera framing).
const zoneScreenPos = (page, phase, dir, height) => page.evaluate(([phase, dir, height]) => {
  const canvas = document.querySelector('#game-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const cam = new THREE.PerspectiveCamera(46, rect.width / rect.height || (16 / 9), 0.1, 220);
  const keep = phase !== 'shoot';
  const pos = keep ? [0, 2.4, -9.5] : [0, 2.6, 17.5];
  const look = keep ? [0, 1.3, 11] : [0, 1.4, 0];
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(look[0], look[1], look[2]);
  cam.updateMatrixWorld();
  const ci = ['left', 'center', 'right'].indexOf(dir);
  const x = -7.32 / 3 + ci * (7.32 / 3);
  const zy = height === 'high' ? 2.44 * 0.75 : 2.44 * 0.25;
  const v = new THREE.Vector3(x, zy, 0).project(cam);
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
}, [phase, dir, height]);

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title:not(.hidden)', { timeout: 15000 });
    await page.waitForFunction(() => !!window.SpotKickDebug);
    const titleName = (await page.textContent('#title-heading')).trim();
    if (!/^SPOT KICK$/i.test(titleName)) throw new Error(`unexpected title "${titleName}"`);
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible ("${titleName}")`);

    // Help overlay (real control) — open then close.
    await page.keyboard.press('h');
    await page.waitForSelector('#overlay-help:not(.hidden)');
    await page.screenshot({ path: SHOT('help', name) });
    await page.click('#overlay-help [data-action="close-help"]');
    await page.waitForFunction(() => document.getElementById('overlay-help').classList.contains('hidden'));
    ok(`${name}: help overlay opens and closes`);

    // Play → Quick Match setup → Start Match
    await page.click('#btn-play');
    await page.waitForSelector('#screen-setup:not(.hidden)');
    const setupTitle = (await page.textContent('#setup-title')).trim();
    if (!/Quick Match/i.test(setupTitle)) throw new Error(`unexpected setup "${setupTitle}"`);
    await page.screenshot({ path: SHOT('setup', name) });
    ok(`${name}: play setup ("${setupTitle}") shown`);

    await page.click('#btn-start-match');
    await page.waitForSelector('#screen-play:not(.hidden)', { timeout: 15000 });

    // match starts active, human (A) to move
    const phase0 = await waitHumanTurn(page);
    if (phase0 !== 'shoot') throw new Error(`expected first human turn = shoot, got "${phase0}"`);
    ok(`${name}: match live — human's kick to shoot`);

    if (full) {
      // pause → resume via visible controls (real), and enable reduced
      // motion (a real accessibility option) to make kick animations settle
      // fast — speeds the playthrough and exercises the setting.
      await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.screenshot({ path: SHOT('pause', name) });
      await page.check('#opt-reduced-motion');
      await page.click('#overlay-pause [data-action="resume"]');
      await page.waitForFunction(() => document.getElementById('overlay-pause').classList.contains('hidden'));
      await waitHumanTurn(page);
      ok(`${name}: pause (Esc), resume + reduced-motion work`);
    }

    // play the shootout to a real decision with alternating shots/dives.
    const cur = { dir: 'center', height: 'low' };
    const MOVES = [
      { dir: 'center', height: 'low', curve: 'none', timing: 'on' },
      { dir: 'right', height: 'high', curve: 'right', timing: 'early' },
      { dir: 'left', height: 'low', curve: 'left', timing: 'late' },
    ];
    let moves = 0, last = null;
    for (let guard = 0; guard < 80; guard++) {
      const st = await readMatch(page);
      if (!st) throw new Error('match handle missing while playing');
      if (st.over) { last = st; break; }
      const phase = await waitHumanTurn(page);
      if (phase === 'over') { last = await readMatch(page); break; }
      if (phase === 'shoot') await humanMove(page, 'shoot', MOVES[moves % 3], cur);
      else await humanMove(page, 'dive', MOVES[moves % 3], cur);
      moves++;
      // wait until our action registered (tick advances) or the match ended
      const before = st.tick;
      try {
        await page.waitForFunction((t) => {
          const D = window.SpotKickDebug;
          const g = D && D.G;
          const s = g && g.match && g.match.state;
          return !!s && (s.tick > t || s.over);
        }, before, { timeout: 8000 });
      } catch {
        throw new Error(`human ${phase} move ${moves} did not register (tick stayed at ${before})`);
      }
    }
    if (!last || !last.over) throw new Error(`match did not reach a decision after ${moves} human moves`);
    ok(`${name}: played ${moves} real moves — match decided (${last.scoreA}–${last.scoreB}, winner ${last.winner}, reason ${last.terminalReason})`);

    if (full) {
      // results screen
      await page.waitForSelector('#screen-results:not(.hidden)', { timeout: 10000 });
      const headline = (await page.textContent('#results-headline')).trim();
      if (!headline) throw new Error('empty results headline');
      const rows = await page.locator('#results-body table tr').count();
      if (rows < 3) throw new Error(`expected score breakdown rows, got ${rows}`);
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: results shown — "${headline}" (${rows} breakdown rows, terminal ${last.terminalReason})`);

      // persisted guest profile: a match was recorded and a winner determined
      const pr = await page.evaluate(() => {
        const raw = localStorage.getItem('spotkick.save.v1');
        if (!raw) return null;
        const body = raw.slice(0, raw.lastIndexOf('.'));
        return JSON.parse(body).data;
      });
      if (!pr || !pr.stats || pr.stats.matches < 1) throw new Error('match not persisted: ' + JSON.stringify(pr));
      ok(`${name}: profile persisted (matches ${pr.stats.matches}, wins ${pr.stats.wins}, goals ${pr.stats.goals})`);

      // Replay button restarts, wait for the match to go live, then leave
      await page.click('#screen-results [data-action="replay"]');
      await page.waitForSelector('#screen-play:not(.hidden)', { timeout: 15000 });
      await waitHumanTurn(page); // countdown done → active
      ok(`${name}: Replay restarts a match`);
      await page.keyboard.press('Escape'); // pause during replay
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#overlay-pause [data-action="leave"]');
      await page.waitForSelector('#screen-title:not(.hidden)');
      ok(`${name}: left match back to title`);
    } else {
      // mobile keeps the match going and verifies a real touch action landed
      const after = await readMatch(page);
      if (after.kicksA + after.kicksB < 1) throw new Error('no kick registered after mobile play');
      await page.screenshot({ path: SHOT('mobile-advanced', name) });
      ok(`${name}: advanced to kick ${after.kicksA + after.kicksB} via touch (score ${after.scoreA}–${after.scoreB})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- mobile: real moves via touchscreen.tap ----------
async function runMobile(browser, name) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title:not(.hidden)', { timeout: 15000 });
    await page.tap('#btn-play');
    await page.waitForSelector('#screen-setup:not(.hidden)');
    await page.tap('#btn-start-match');
    await page.waitForSelector('#screen-play:not(.hidden)', { timeout: 15000 });
    const phase0 = await waitHumanTurn(page);
    if (phase0 !== 'shoot') throw new Error(`mobile: expected shoot, got "${phase0}"`);
    ok(`${name}: match live (human shoot)`);

    // One real touch action: tap a visible goal zone on the canvas, set a
    // curve via the on-screen button, confirm with the visible button.
    const pos = await zoneScreenPos(page, 'shoot', 'right', 'high');
    if (!pos) throw new Error('could not project goal zone for touch');
    await page.touchscreen.tap(pos.x, pos.y);
    const zoned = await page.evaluate(() => !!window.SpotKickDebug.G.sel.zone);
    if (!zoned) throw new Error('canvas goal-zone tap did not select a zone');
    await page.touchscreen.tap((await page.locator('[data-curve="right"]').boundingBox()).x + 10,
      (await page.locator('[data-curve="right"]').boundingBox()).y + 10);
    await page.screenshot({ path: SHOT('mobile-aim', name) });
    await page.touchscreen.tap((await page.locator('#btn-confirm-shot').boundingBox()).x + 10,
      (await page.locator('#btn-confirm-shot').boundingBox()).y + 10);

    const before = (await page.evaluate(() => window.SpotKickDebug.G.match.state.kicksA + window.SpotKickDebug.G.match.state.kicksB));
    // wait for the kick to register
    await page.waitForFunction((n) => {
      const D = window.SpotKickDebug; const g = D && D.G;
      const s = g && g.match && g.match.state;
      return !!s && (s.kicksA + s.kicksB > n);
    }, before, { timeout: 8000 }).catch(() => {});
    const st = await readMatch(page);
    if (!st || st.kicksA + st.kicksB < 1) throw new Error('mobile: touch shot did not register a kick');
    await page.screenshot({ path: SHOT('mobile-shot', name) });
    ok(`${name}: real touch shot landed — score ${st.scoreA}–${st.scoreB}, kicks ${st.kicksA + st.kicksB}`);

    // A second touch dive on the keeper turn (opposite camera) — makes a
    // couple of real moves, then stop (mobile pass intentionally shorter).
    const phase1 = await waitHumanTurn(page);
    if (phase1 === 'dive') {
      const p2 = await zoneScreenPos(page, 'keep', 'left', 'low');
      if (p2) {
        await page.touchscreen.tap(p2.x, p2.y);
        const zoned2 = await page.evaluate(() => !!window.SpotKickDebug.G.sel.zone);
        if (zoned2) {
          await page.touchscreen.tap((await page.locator('[data-timing="early"]').boundingBox()).x + 10,
            (await page.locator('[data-timing="early"]').boundingBox()).y + 10);
          await page.touchscreen.tap((await page.locator('#btn-confirm-dive').boundingBox()).x + 10,
            (await page.locator('#btn-confirm-dive').boundingBox()).y + 10);
          await page.waitForFunction((n) => {
            const D = window.SpotKickDebug; const g = D && D.G;
            const s = g && g.match && g.match.state;
            return !!s && s.tick > n;
          }, st.tick, { timeout: 8000 }).catch(() => {});
          ok(`${name}: second real touch dive landed`);
        }
      }
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runMobile(browser, 'mobile');
  console.log('\nE2E PASS — spot-kick, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
