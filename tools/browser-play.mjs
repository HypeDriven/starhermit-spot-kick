// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1 is
// won by mouse (the six-zone grid and Kick! / Dive!, every other shot by a
// click on the goal itself), with a pause by Escape; on the phone Learn is
// played to its end by finger on the goal's zones; sideways today's Daily is
// played to its result by finger on the zone grid. Every turn and the result
// come from the rules (tools/gen-plays.mjs simulate). Widgets and the goal's
// named zone targets are found through the page's accessibility mirror of the
// engine's UI. Screenshots of each step go to --shots. Fails on console errors
// or warnings, the runtime's error screen, or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { simulate, plans } from './gen-plays.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const NAME = { left: 'Left', center: 'Center', right: 'Right' };
  const results = async (headline) => { await page.getByText('Replay verified: yes', { exact: false }).first().waitFor({ timeout: 120000 }); await page.getByText(headline, { exact: true }).first().waitFor({ timeout: 5000 }); await page.waitForTimeout(600); };
  /** One human turn: wait for the panel, pick the zone (grid button or the goal's target), curve / timing, confirm. */
  const turn = async (t, onGoal, k) => {
    const confirm = t.kind === 'dive' ? 'Dive!' : 'Kick!';
    await page.getByRole('button', { name: confirm, exact: true }).first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(500);
    if (onGoal) {
      const target = page.getByRole('button', { name: `Goal zone ${t.choice.dir} ${t.choice.height}`, exact: true }).first();
      await target.waitFor({ timeout: 15000 });
      const b = await target.boundingBox();
      await tapAt(b.x + b.width / 2, b.y + b.height / 2);
    } else await press(`${NAME[t.choice.dir]} ${t.choice.height}`);
    if (t.kind === 'shoot' && t.choice.curve !== 'none') await press(t.choice.curve === 'left' ? 'Curve ↰' : 'Curve ↱');
    if (t.kind === 'dive' && t.choice.timing !== 'on') await press(t.choice.timing === 'early' ? 'Early' : 'Late');
    if (k === 0) await shot('first-pick');
    await press(confirm);
  };
  try {
    await shot('title');
    if (v.name === 'desktop') {
      const sim = plans.journey(0);
      await press(/^Journey \d/);
      await press('Start Match');
      for (const [k, t] of sim.turns.entries()) {
        await turn(t, k % 2 === 1, k);
        if (k === 2) {
          await page.waitForTimeout(400);
          await shot('flight');
          await page.getByRole('button', { name: 'Kick!', exact: true }).or(page.getByRole('button', { name: 'Dive!', exact: true })).first().waitFor({ timeout: 60000 });
          await page.keyboard.press('Escape');
          await find('Resume').waitFor({ timeout: 15000 });
          await page.waitForTimeout(500);
          await shot('pause');
          await press('Resume');
          await page.waitForTimeout(500);
        }
      }
      await results(sim.headline);
      await shot('journey-1-results');
    } else if (v.name === 'phone') {
      const sim = plans.learn();
      await press('Learn');
      for (const [k, t] of sim.turns.entries()) { await turn(t, true, k); if (k === 1) { await page.waitForTimeout(300); await shot('learn-flight'); } }
      await results(sim.headline);
      await shot('learn-results');
    } else {
      const sim = plans.daily(new Date().toISOString().slice(0, 10));
      await press('Daily Challenge');
      await press('Start Match');
      for (const [k, t] of sim.turns.entries()) { await turn(t, false, k); if (k === 1) await shot('daily-keep'); }
      await results(sim.headline);
      await shot('daily-results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
