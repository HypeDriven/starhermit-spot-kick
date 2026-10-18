// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics from the
// title, starts a Quick Match against the AI and plays every human turn through the real controls (Enter on
// the zone cursor, a curve/timing segment button, the Confirm button), so the ball flies, the keeper dives,
// the camera swaps ends and the crowd, floodlight beams and motes animate; a decided match is replayed from
// the results screen (no reloads).
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not(.hidden)', { timeout: 30000 });
  await page.click('#screen-title [data-action="settings"]');
  await page.waitForSelector('#overlay-pause:not(.hidden)');
  await page.selectOption('#opt-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#overlay-pause [data-action="resume"]');
  await page.waitForSelector('#overlay-pause', { state: 'hidden' });
}

const turn = (page) => page.evaluate(() => {
  if (!document.getElementById('screen-results').classList.contains('hidden')) return 'results';
  const g = window.SpotKickDebug?.G, st = g?.match?.state;
  if (!st || st.over || g.appState !== 'active') return null;
  const visible = (id) => !document.getElementById(id).classList.contains('hidden');
  if (st.phase === 'shooter' && st.shooter === 'A' && visible('panel-shoot')) return 'shoot';
  if (st.phase === 'keeper' && st.shooter === 'B' && visible('panel-dive')) return 'dive';
  return null;
});

const CURVES = ['left', 'none', 'right'], TIMINGS = ['early', 'on', 'late'];
let n = 0;

async function step(page, press) {
  const t = await turn(page);
  if (t === 'results') {
    await press('#screen-results [data-action="replay"]');
    await page.waitForSelector('#screen-play:not(.hidden)', { timeout: 15000 });
  } else if (t) {
    n++;
    await page.keyboard.press(n % 2 ? 'ArrowLeft' : 'ArrowRight'); // move the zone cursor
    await page.keyboard.press('Enter');                             // pick that zone
    if (t === 'shoot') { await press(`[data-curve="${CURVES[n % 3]}"]`); await press('#btn-confirm-shot'); }
    else { await press(`[data-timing="${TIMINGS[n % 3]}"]`); await press('#btn-confirm-dive'); }
  }
}

export async function start(page, { mobile } = {}) {
  const press = (sel) => (mobile ? page.tap(sel, { timeout: 3000 }) : page.click(sel, { timeout: 3000 }));
  await press('#btn-play');
  await page.waitForSelector('#screen-setup:not(.hidden)');
  await press('#btn-start-match');
  await page.waitForSelector('#screen-play:not(.hidden)', { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, press); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(250).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
