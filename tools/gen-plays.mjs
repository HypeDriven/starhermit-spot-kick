// Writes the native play scripts (tests/native/*.play) from the rules: each
// match is simulated with js/session.js exactly as the client plays it (the
// AI keeper dives as soon as it is its turn, the human's choices are a fixed
// plan), so the scripts know every turn and the final result in advance and
// `expect` it. A turn is played through the real UI — the six-zone grid's
// buttons and Kick! / Dive! by mouse, the goal's named zone targets by finger,
// or the zone cursor by keys (arrows move it from where it last was, Enter
// selects, Enter again kicks / dives; Q / E curve, 1 / 2 / 3 time the dive).
// tests/native.mjs also calls dailyScript() at test time for the day's Daily.
//   node tools/gen-plays.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rules = require('../js/rules.js');
const content = require('../js/content.js');
const session = require('../js/session.js');

const COLS = ['left', 'center', 'right'];
const NAME = { left: 'Left', center: 'Center', right: 'Right' };
const zoneLabel = (z) => `${NAME[z.dir]} ${z.height}`;
const zoneTarget = (z) => `Goal zone ${z.dir} ${z.height}`;
const CURVE_BTN = { left: '=Curve ↰', right: '=Curve ↱' };
const TIMING_BTN = { early: '=Early', late: '=Late' };
const TIMING_KEY = { early: 'Digit1', on: 'Digit2', late: 'Digit3' };

/** A plan's choice for the n-th human shot / dive (a fixed, varied sequence; `salt` picks another). */
function planner(salt, opts = {}) {
  let s = (salt * 2654435761) >>> 0;
  const r = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) % n; };
  return {
    shot(state) {
      const legal = rules.legalActions(state).filter((a) => a.type === 'shoot').map((a) => a.params)
        .filter((p) => opts.curves || p.curve === 'none' || !legalHasStraight(state));
      return legal[r(legal.length)];
    },
    dive() { return { dir: COLS[r(3)], height: r(2) ? 'high' : 'low', timing: opts.timings ? ['early', 'on', 'late'][r(5) % 3] : 'on' }; },
  };
}
function legalHasStraight(state) { return rules.legalActions(state).some((a) => a.type === 'shoot' && a.params.curve === 'none'); }

/**
 * Simulates a match as main.ts plays it; returns the human turns (kind, choice) and the end.
 * humans: the sides this device plays ('A' vs the AI, or both for two players).
 */
export function simulate(cfg, plan, humans = ['A'], pre = null) {
  const m = session.createSession({ seed: cfg.seed, rounds: cfg.rounds, constraints: cfg.constraints || null, mode: cfg.mode || 'journey',
    ai: humans.length === 2 ? null : { side: 'B', difficulty: cfg.aiDifficulty || 0 } });
  const turns = [];
  for (let guard = 0; guard < 200 && !m.state.over; guard++) {
    session.aiAct(m);
    if (m.state.over) break;
    const st = m.state;
    const keeper = st.phase === 'keeper';
    const side = keeper ? rules.keeperSide(st) : st.shooter;
    const choice = (pre && pre(turns.length, keeper, st)) || (keeper ? plan.dive(st) : plan.shot(st));
    turns.push({ kind: keeper ? 'dive' : 'shoot', side, choice });
    const res = session.submit(m, keeper ? 'dive' : 'shoot', side, choice);
    if (!res.ok) throw new Error(`illegal plan step: ${res.reason}`);
  }
  const st = m.state;
  return { turns, state: st, headline: humans.length === 2 ? (st.winner === 'A' ? 'Player A wins!' : 'Player B wins!') : st.winner === 'A' ? 'You win!' : 'Rival wins' };
}

const WAIT = (kind) => [`until 1500 =${kind === 'dive' ? 'Dive!' : 'Kick!'}`, 'frames 12'];
/** A turn by mouse on the grid's buttons. */
function byMouse(t, verb = 'click') {
  const out = [`# ${t.side} ${t.kind} ${JSON.stringify(t.choice)}`, ...WAIT(t.kind), `${verb} =${zoneLabel(t.choice)}`, 'frames 5'];
  if (t.kind === 'shoot' && t.choice.curve !== 'none') out.push(`${verb} ${CURVE_BTN[t.choice.curve]}`, 'frames 5');
  if (t.kind === 'dive' && t.choice.timing !== 'on') out.push(`${verb} ${TIMING_BTN[t.choice.timing]}`, 'frames 5');
  out.push(`${verb} =${t.kind === 'dive' ? 'Dive!' : 'Kick!'}`, 'frames 5');
  return out;
}
/** A turn by finger: the goal's zone target, the segment, the confirm button. */
function byTouch(t) {
  const out = [`# ${t.side} ${t.kind} ${JSON.stringify(t.choice)}`, ...WAIT(t.kind), `touch ${zoneTarget(t.choice)}`, 'frames 8'];
  if (t.kind === 'shoot' && t.choice.curve !== 'none') out.push(`touch ${CURVE_BTN[t.choice.curve]}`, 'frames 8');
  if (t.kind === 'dive' && t.choice.timing !== 'on') out.push(`touch ${TIMING_BTN[t.choice.timing]}`, 'frames 8');
  out.push(`touch =${t.kind === 'dive' ? 'Dive!' : 'Kick!'}`, 'frames 8');
  return out;
}
/** A turn by keys: the zone cursor (it stays where the last selection was), Enter, Enter. */
function byKeys(turns) {
  let cur = { dir: 'center', height: 'low' };
  const out = [];
  for (const t of turns) {
    out.push(`# ${t.side} ${t.kind} ${JSON.stringify(t.choice)}`, ...WAIT(t.kind));
    let ci = COLS.indexOf(cur.dir);
    const ti = COLS.indexOf(t.choice.dir);
    while (ci < ti) { out.push('key ArrowRight 1', 'frames 3'); ci++; }
    while (ci > ti) { out.push('key ArrowLeft 1', 'frames 3'); ci--; }
    if (t.choice.height !== cur.height) out.push(`key ${t.choice.height === 'high' ? 'ArrowUp' : 'ArrowDown'} 1`, 'frames 3');
    out.push('key Enter 1', 'frames 5');
    // the curve cycles straight → left → right (E) and back (Q), as bootstrap.js cycleCurve did
    if (t.kind === 'shoot' && t.choice.curve === 'left') out.push('key KeyE 1', 'frames 3');
    if (t.kind === 'shoot' && t.choice.curve === 'right') out.push('key KeyQ 1', 'frames 3');
    if (t.kind === 'dive' && t.choice.timing !== 'on') out.push(`key ${TIMING_KEY[t.choice.timing]} 1`, 'frames 3');
    out.push('key Enter 1', 'frames 5');
    cur = { dir: t.choice.dir, height: t.choice.height };
  }
  return out;
}
const RESULTS = (sim) => ['until 1500 Replay verified: yes', `expect =${sim.headline}`, 'frames 10'];
const header = (what, vp) => [`# Generated by tools/gen-plays.mjs: ${what}`, `# viewport ${vp}`];

/** The first plan salt whose match the human wins (or the first one). */
function winningPlan(cfg, opts, humans = ['A'], want = true) {
  for (let salt = 1; salt < 400; salt++) {
    const sim = simulate(cfg, planner(salt, opts), humans);
    if (!want || sim.state.winner === 'A') return sim;
  }
  throw new Error(`no winning plan for ${cfg.id}`);
}

function journey() {
  const J = content.JOURNEY;
  const lines = [...header('Journey stages 1 and 2 on a desktop by mouse (the zone grid, Kick! / Dive!), each won; stage 2 starts from Next.', '1280x720@1'),
    'until 600 =Play', 'frames 30', 'click =Journey', 'until 300 =Start Match', 'frames 10', 'save journey-setup', 'click =Start Match'];
  for (let i = 0; i < 2; i++) {
    const sim = plans.journey(i);
    lines.push(`# ${J[i].id}: ${sim.state.scoreA}–${sim.state.scoreB}`);
    sim.turns.forEach((t, k) => { lines.push(...byMouse(t)); if (i === 0 && k === 0) lines.push('frames 20', 'save journey-flight'); if (i === 0 && k === 1) lines.push('until 400 =Kick!', 'frames 20', 'save journey-keep'); });
    lines.push(...RESULTS(sim), `expect Next recommended: Stage ${i + 2}`);
    if (i === 0) lines.push('save journey-results', 'click =Next');
  }
  return lines;
}
function learnSim() {
  const cfg = { id: 'learn', seed: 0x1eaa47, rounds: 3, aiDifficulty: 0, constraints: null, mode: 'learn' };
  // the lessons: aim, keep, bend it (a curved shot), time a dive, finish the set
  const pre = (n, keeper) => (n === 2 && !keeper ? { dir: 'left', height: 'high', curve: 'right' } : n === 3 && keeper ? { dir: 'center', height: 'low', timing: 'early' } : null);
  return simulate(cfg, planner(1, {}), ['A'], pre);
}
function learnPhone() {
  const sim = learnSim();
  const lines = [...header('Learn on a phone (390 × 844 at DPR 3) by finger: the goal\'s zone targets, the segment, Kick! / Dive!; every lesson to the end of the set.', '390x844@3'),
    'until 600 =Play', 'frames 30', 'touch =Learn', 'until 400 =Kick!', 'frames 20', 'save learn-phone'];
  sim.turns.forEach((t, k) => { lines.push(...byTouch(t)); if (k === 2) lines.push('frames 2', 'save learn-phone-curve'); });
  lines.push(...RESULTS(sim), 'expect Tutorial done', 'save learn-phone-results');
  return lines;
}
function practiceLandscape() {
  const cfg = { id: 'practice', seed: 0, rounds: 5, aiDifficulty: 1, constraints: null, mode: 'practice' };
  // Practice uses a random seed: only the first kick is played (by keys), undone, then the match is left.
  return [...header('Practice on a short landscape phone (844 × 390) by keys: a shot, Undo (U), pause (Esc), Leave match.', '844x390@3'),
    'until 600 =Play', 'frames 30', 'click =Practice', 'until 300 =Club', 'frames 10', 'click =Sharp', 'frames 5', 'click =Start Match',
    ...byKeys([{ side: 'A', kind: 'shoot', choice: { dir: 'right', height: 'high', curve: 'right' } }]),
    'until 400 =Dive!', 'frames 30', 'save practice-land-keep', 'expect =Undo', 'key KeyU 1', 'frames 10', 'until 300 =Kick!', 'expect kick 1 of 10',
    'frames 20', 'save practice-land-undone', 'key Escape 1', 'until 120 =Resume', 'frames 10', 'save practice-land-pause', 'click =Leave match', 'until 300 =Play', 'frames 10'];
}
function hotseat() {
  // two players: B's dives wander, A shoots away from them; A dives where B then shoots (saved) — straight shots only, so the
  // result does not depend on Quick Match's random seed
  const cfg = { id: 'hotseat', seed: 1, rounds: 5, constraints: null, mode: 'play' };
  const plan = planner(11, {});
  let lastDive = null;
  const pre = (n, keeper, st) => {
    const side = keeper ? rules.keeperSide(st) : st.shooter;
    if (keeper) { lastDive = side === 'A' ? { dir: COLS[n % 3], height: 'low', timing: 'on' } : plan.dive(); return lastDive; }
    if (side === 'A') return { dir: COLS[(COLS.indexOf(lastDive.dir) + 1) % 3], height: lastDive.height === 'low' ? 'high' : 'low', curve: 'none' };
    return { dir: lastDive.dir, height: lastDive.height, curve: 'none' };
  };
  const sim = simulate(cfg, plan, ['A', 'B'], pre);
  return [...header(`Quick Match, two players on this device, by keys (the zone cursor, Enter selects, Enter again kicks / dives): ${sim.state.scoreA}–${sim.state.scoreB}.`, '1280x720@1'),
    'until 600 =Play', 'frames 30', 'click =Play', 'until 300 =Two players · this device', 'click =Two players · this device', 'frames 5', 'click =Start Match',
    'until 600 =Dive!', 'frames 10', 'expect Player B keeping',
    ...byKeys(sim.turns), ...RESULTS(sim), 'save hotseat-results'];
}
function challenge() {
  const ch = content.CHALLENGES.find((c) => c.id === 'c-sprint');
  const sim = simulate({ ...ch, mode: 'challenge' }, planner(3, { curves: true }), ['A'], (n, keeper, st) => (n === 0 ? autoChoice(keeper, st) : null));
  // the first decision is left to the clock (Speed Set: 6 s, then the default choice is committed)
  const lines = [...header('Challenge Speed Set on a desktop: the first decision runs out (6 s, the default shot), the rest by mouse.', '1280x720@1'),
    'until 600 =Play', 'frames 30', 'click =Challenge', 'until 300 Speed Set', 'frames 10', 'click Speed Set', 'frames 5', 'expect 3 kicks each', 'click =Start Match',
    'until 600 =Kick!', 'frames 120', 'save challenge-clock', 'expect 4s'];
  sim.turns.slice(1).forEach((t) => lines.push(...byMouse(t)));
  lines.push(...RESULTS(sim));
  return lines;
}
function autoChoice(keeper, st) {
  if (keeper) return { dir: 'center', height: 'low', timing: 'on' };
  const first = rules.legalActions(st)[0];
  return { dir: first.params.dir, height: first.params.height, curve: 'none' };
}
function menus() {
  return [...header('The menus on a desktop: Settings (captions off and on, a theme), Help, the Daily\'s setup, the Challenge list, back to the title.', '1280x720@1'),
    'until 600 =Play', 'frames 30', 'save menus-title', 'click =Settings', 'until 120 =Theme', 'frames 10', 'save menus-settings',
    'click =Captions #2', 'frames 5', 'click =Captions #2', 'frames 5', 'click =Midnight Floodlights', 'frames 5', 'click =Aurora Park', 'frames 60', 'save menus-aurora',
    'click =Aurora Park', 'frames 5', 'click =Midnight Floodlights', 'frames 30',
    'click =How to play', 'until 120 Goalkeeping', 'frames 10', 'save menus-help', 'click =Close', 'frames 10', 'click =Back', 'until 120 =Play', 'frames 5',
    'click =Daily Challenge', 'until 120 (UTC)', 'frames 10', 'save menus-daily', 'click =Back', 'until 120 =Play', 'frames 5',
    'click =Challenge', 'until 120 Bend or Bust', 'frames 10', 'click Brick Wall', 'frames 5', 'expect goal: clean sheet', 'save menus-challenge',
    'key Escape 1', 'until 120 =Play', 'frames 10', 'click =Help', 'until 120 Goalkeeping', 'key Escape 1', 'until 120 =Play'];
}

/** The day's Daily (desktop by mouse) — written at test time by tests/native.mjs. */
function dailySim(day) { return simulate({ ...content.dailyFor(day), mode: 'daily' }, planner(5, { curves: true, timings: true })); }
export function dailyScript(day) {
  const sim = dailySim(day);
  return [`# Generated at test time by tests/native.mjs (tools/gen-plays.mjs dailyScript): the Daily of ${day}, by mouse.`, '# viewport 1280x800@1',
    'until 600 =Play', 'frames 30', 'click =Daily Challenge', 'until 300 =Start Match', 'frames 10', 'click =Start Match',
    ...sim.turns.flatMap((t) => byMouse(t)), ...RESULTS(sim), 'expect Next daily arrives at 00:00 UTC.', 'save daily-results'].join('\n') + '\n';
}

/** The simulated matches the browser check plays too. */
export const plans = {
  journey: (i) => winningPlan({ ...content.JOURNEY[i], mode: 'journey' }, {}),
  learn: learnSim,
  daily: dailySim,
};

if (process.argv[1] && process.argv[1].endsWith('gen-plays.mjs')) {
  const out = { 'journey-mouse': journey(), 'learn-phone': learnPhone(), 'practice-landscape': practiceLandscape(), 'hotseat-keys': hotseat(), 'challenge-clock': challenge(), menus: menus() };
  for (const [name, lines] of Object.entries(out)) writeFileSync(new URL(`../tests/native/${name}.play`, import.meta.url), lines.join('\n') + '\n');
  console.log(`wrote ${Object.keys(out).length} play scripts`);
}
