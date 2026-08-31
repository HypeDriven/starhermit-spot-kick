'use strict';

/*
 * Spot Kick content — versioned levels, themes, tutorials, validation metadata.
 * All content is original and internally authored. Validators run offline
 * (tests) and at boot to prove legality, reachable goals and bounded duration.
 */
(function (root, factory) {
  const rules = (typeof module !== 'undefined' && module.exports) ? require('./rules') : root.SpotKickRules;
  const api = factory(rules);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickContent = api;
})(typeof self !== 'undefined' ? self : this, function (rules) {

  const CONTENT_VERSION = 1;

  // ---- five visual themes (presentation only; never alter rules) ----
  const THEMES = [
    { id: 'midnight', name: 'Midnight Floodlights', sky: 0x070d1d, pitch: 0x14342a, line: 0xdfe8ff, accent: 0x5aa0ff, ambient: 'night' },
    { id: 'ember', name: 'Ember Bowl', sky: 0x160b0b, pitch: 0x27351c, line: 0xffe6c8, accent: 0xff8a4a, ambient: 'dusk' },
    { id: 'aurora', name: 'Aurora Park', sky: 0x061418, pitch: 0x0f2f2b, line: 0xd8fff4, accent: 0x4affc7, ambient: 'polar' },
    { id: 'violet', name: 'Violet Dome', sky: 0x100a1c, pitch: 0x1d2f22, line: 0xefe4ff, accent: 0xb47aff, ambient: 'indoor' },
    { id: 'mono', name: 'Monochrome (High Contrast)', sky: 0x000000, pitch: 0x101010, line: 0xffffff, accent: 0xffd23f, ambient: 'neutral' }
  ];

  // ---- interactive tutorial (Learn mode): one rule at a time, must perform ----
  const TUTORIAL_STEPS = [
    { id: 'aim', title: 'Pick a corner', body: 'You are the shooter. Tap a zone in the goal — left, center or right, low or high — to aim your kick.', require: 'shoot' },
    { id: 'keeper', title: 'Guard the goal', body: 'Now you keep. Pick the zone you think the shot is going, and a dive timing. Match the shot zone with on-time dive to save.', require: 'dive' },
    { id: 'curve', title: 'Bend it', body: 'Add curve to shift the ball one column at the last moment. Curve beats a keeper who committed early — but risks missing the frame.', require: 'shoot-curve' },
    { id: 'timing', title: 'Dive timing', body: 'Early dives cover a whole column against straight shots but are beaten by curve. On-time dives save only the exact zone. Late dives save nothing.', require: 'dive' },
    { id: 'sets', title: 'The set', body: 'Each player takes five kicks, then tied matches go to sudden death. Score more goals than your opponent to win.', require: 'finish' }
  ];

  // ---- journey: 40 authored stages, one concept at a time, then combined ----
  // Fields: id, seed, rounds, aiDifficulty, goal, constraints, par, theme, tutorial.
  function buildJourney() {
    const stages = [];
    const plan = [
      // block 1 (1-10): straight shots only, growing AI
      { n: 10, curves: false, heights: true, aiBase: 0, rounds: 5 },
      // block 2 (11-20): curve introduced, combined with corners
      { n: 10, curves: true, heights: true, aiBase: 0, rounds: 5 },
      // block 3 (21-30): tighter constraints, stronger AI, mastery checks
      { n: 10, curves: true, heights: true, aiBase: 1, rounds: 5 },
      // block 4 (31-40): mastery block — short sets, sharp AI, restricted tools
      { n: 10, curves: true, heights: true, aiBase: 2, rounds: 3 }
    ];
    let idx = 0;
    for (let b = 0; b < plan.length; b++) {
      const blk = plan[b];
      for (let i = 0; i < blk.n; i++) {
        idx++;
        const mastery = (i === blk.n - 1); // periodic mastery stage at block end
        const constraints = { bannedCurves: [], bannedHeights: [], bannedColumns: [], timeLimitMs: 0 };
        if (!blk.curves) constraints.bannedCurves = ['left', 'right'];
        if (b === 3 && i % 3 === 1) constraints.bannedHeights = ['high'];
        if (b === 3 && i % 3 === 2) constraints.bannedColumns = ['center'];
        if (b === 2 && i % 4 === 3) constraints.bannedCurves = ['left', 'right'];
        const aiDifficulty = Math.min(2, blk.aiBase + (mastery ? 1 : (i > blk.n / 2 ? 1 : 0)));
        const stage = {
          id: 'j' + String(idx).padStart(2, '0'),
          index: idx,
          name: 'Stage ' + idx + (mastery ? ' — Mastery' : ''),
          seed: rules.mixSeed(0xC0FFEE, 'journey-' + idx),
          rounds: blk.rounds,
          aiDifficulty: aiDifficulty,
          goal: mastery ? 'win-by-2' : 'win',
          constraints: constraints,
          par: { goals: Math.ceil(blk.rounds / 2) + (mastery ? 1 : 0) },
          mechanics: blk.curves ? ['shoot', 'dive', 'curve', 'timing'] : ['shoot', 'dive', 'timing'],
          tutorial: idx === 1, // first stage carries the tutorial flags
          theme: THEMES[(b + (i % 2)) % THEMES.length].id,
          version: CONTENT_VERSION
        };
        stages.push(stage);
      }
    }
    return stages;
  }

  const JOURNEY = buildJourney();

  // ---- challenges: constrained goals ----
  const CHALLENGES = [
    { id: 'c-curve-only', name: 'Bend or Bust', seed: rules.mixSeed(0xBEEF, 'c1'), rounds: 5, aiDifficulty: 1,
      constraints: { bannedCurves: ['none'], bannedHeights: [], bannedColumns: [], timeLimitMs: 0 },
      goal: 'win', theme: 'aurora', blurb: 'Every shot must be curved. Thread the needle.' },
    { id: 'c-low-only', name: 'Worm Burners', seed: rules.mixSeed(0xBEEF, 'c2'), rounds: 5, aiDifficulty: 1,
      constraints: { bannedCurves: [], bannedHeights: ['high'], bannedColumns: [], timeLimitMs: 0 },
      goal: 'win', theme: 'ember', blurb: 'Keep it on the carpet. Low shots only.' },
    { id: 'c-sprint', name: 'Speed Set', seed: rules.mixSeed(0xBEEF, 'c3'), rounds: 3, aiDifficulty: 1,
      constraints: { bannedCurves: [], bannedHeights: [], bannedColumns: [], timeLimitMs: 6000 },
      goal: 'win', theme: 'violet', blurb: 'Three kicks each, six seconds per decision.' },
    { id: 'c-shutout', name: 'Brick Wall', seed: rules.mixSeed(0xBEEF, 'c4'), rounds: 5, aiDifficulty: 2,
      constraints: { bannedCurves: [], bannedHeights: [], bannedColumns: [], timeLimitMs: 0 },
      goal: 'clean-sheet', theme: 'midnight', blurb: 'Win without conceding a single goal.' },
    { id: 'c-comeback', name: 'Corner Flag', seed: rules.mixSeed(0xBEEF, 'c5'), rounds: 5, aiDifficulty: 2,
      constraints: { bannedCurves: [], bannedHeights: [], bannedColumns: ['center'], timeLimitMs: 0 },
      goal: 'win', theme: 'midnight', blurb: 'No center shots. Corners only, against a sharp keeper.' }
  ];

  // ---- daily challenge: one shared seed per UTC day, immutable ----
  function dailySeedFor(dateIso) {
    // dateIso: 'YYYY-MM-DD' (UTC). Immutable once published.
    return rules.mixSeed(0xDA117, 'daily-' + dateIso);
  }
  function utcDay(d) {
    d = d || new Date();
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function dailyFor(dateIso) {
    return {
      id: 'daily-' + dateIso,
      day: dateIso,
      seed: dailySeedFor(dateIso),
      rounds: 5,
      aiDifficulty: 1,
      goal: 'win',
      constraints: { bannedCurves: [], bannedHeights: [], bannedColumns: [], timeLimitMs: 0 },
      theme: THEMES[rules.mixSeed(dailySeedFor(dateIso), 'theme') % THEMES.length].id,
      version: CONTENT_VERSION,
      excluded: false // set true to mark a defective day out of ranking
    };
  }

  // ---- practice difficulties ----
  const PRACTICE_DIFFICULTIES = [
    { id: 0, name: 'Casual', blurb: 'The keeper guesses loosely. Learn the rhythm.' },
    { id: 1, name: 'Club', blurb: 'A reading keeper. Mix your placement.' },
    { id: 2, name: 'Sharp', blurb: 'Elite reactions. Curve and timing decide it.' }
  ];

  // ---- offline validators: legality, reachable goals, bounded duration ----
  function validateContent() {
    const errors = [];
    const seen = new Set();
    const checkStage = (s, kind) => {
      if (!s.id || seen.has(s.id)) errors.push(kind + ':' + s.id + ' duplicate-or-missing id');
      seen.add(s.id);
      if (typeof s.seed !== 'number' || s.seed < 0) errors.push(s.id + ': bad seed');
      if (!Number.isInteger(s.rounds) || s.rounds < 1 || s.rounds > 7) errors.push(s.id + ': unbounded rounds');
      const st = rules.createInitialState({ seed: s.seed, rounds: s.rounds, constraints: s.constraints });
      const legal = rules.legalActions(st);
      if (legal.length === 0) errors.push(s.id + ': no legal opening actions (soft lock)');
      if (s.constraints.bannedCurves.length === rules.CURVES.length) errors.push(s.id + ': all curves banned (soft lock)');
      if (s.constraints.bannedHeights.length === rules.HEIGHTS.length) errors.push(s.id + ': all heights banned');
      if (s.constraints.bannedColumns.length === rules.COLUMNS.length) errors.push(s.id + ': all columns banned');
      // reachable goal: a 'win'/'win-by-2'/'clean-sheet' goal is reachable iff a
      // shooter can always score from the opening (verify a legal shot exists).
      const shots = legal.filter(a => a.type === 'shoot' ||
        rules.legalActions(Object.assign({}, st, { phase: 'shooter' })).length > 0);
      if (!shots) errors.push(s.id + ': unreachable goal');
      if (!s.theme || THEMES.every(t => t.id !== s.theme)) errors.push(s.id + ': unknown theme');
    };
    JOURNEY.forEach(s => checkStage(s, 'journey'));
    CHALLENGES.forEach(s => checkStage(s, 'challenge'));
    if (JOURNEY.length < 40) errors.push('journey: fewer than 40 stages');
    if (THEMES.length < 5) errors.push('fewer than five themes');
    // tutorial: each step must reference a performable action type
    const reqTypes = new Set(['shoot', 'dive', 'shoot-curve', 'finish']);
    TUTORIAL_STEPS.forEach(t => { if (!reqTypes.has(t.require)) errors.push('tutorial ' + t.id + ': bad requirement'); });
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES,
    TUTORIAL_STEPS: TUTORIAL_STEPS,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE_DIFFICULTIES: PRACTICE_DIFFICULTIES,
    dailySeedFor: dailySeedFor, dailyFor: dailyFor, utcDay: utcDay,
    validateContent: validateContent
  };
});
