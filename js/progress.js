'use strict';

/*
 * Spot Kick progression and options model — the save document (journey
 * stages, achievements, daily results, streaks, stats, the finished
 * tutorial), its merge for two devices (js/ui.js mergeSaves, unchanged), the
 * achievement table, the browser build's cloud slot (the checksummed
 * session.encodeSave text) read as a foreign save, and the game's own options
 * with the browser build's settings-KV values they carry over from. Pure (no
 * DOM, no engine): the engine client and the node tests share it.
 * Works in Node (module.exports) and as a classic script (SpotKickProgress).
 */
(function (root, factory) {
  const session = (typeof module !== 'undefined' && module.exports) ? require('./session') : root.SpotKickSession;
  const content = (typeof module !== 'undefined' && module.exports) ? require('./content') : root.SpotKickContent;
  const api = factory(session, content);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickProgress = api;
})(typeof self !== 'undefined' ? self : this, function (session, content) {

  const SAVE_DEFAULTS = {
    journeyDone: [], achievements: {}, dailyResults: {},
    streak: 0, bestStreak: 0, stats: { goals: 0, saves: 0, curvedGoals: 0, wins: 0, matches: 0, dailies: 0 },
    tutorialDone: false
  };
  const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

  /** A save document with every field present (malformed parts → defaults). */
  function normalize(raw) {
    const r = obj(raw);
    const stats = Object.assign({}, SAVE_DEFAULTS.stats);
    for (const [k, v] of Object.entries(obj(r.stats))) if (Number.isFinite(Number(v))) stats[k] = Number(v);
    return {
      journeyDone: Array.isArray(r.journeyDone) ? r.journeyDone.filter((x) => typeof x === 'string') : [],
      achievements: Object.assign({}, obj(r.achievements)),
      dailyResults: Object.assign({}, obj(r.dailyResults)),
      streak: Number(r.streak) || 0,
      bestStreak: Number(r.bestStreak) || 0,
      stats: stats,
      tutorialDone: !!r.tutorialDone
    };
  }

  /**
   * Merge two save docs without dropping either side (js/ui.js mergeSaves):
   * finished journey stages and achievements are unioned (earliest unlock
   * kept), daily results keep whichever was recorded (the remote copy first),
   * the streak, best streak and every stat keep the larger value, a finished
   * tutorial stays finished. Either side may be null.
   */
  function mergeSaves(remote, local) {
    const R = Object.assign({}, SAVE_DEFAULTS, obj(remote)), L = Object.assign({}, SAVE_DEFAULTS, obj(local));
    const achievements = Object.assign({}, obj(R.achievements));
    for (const [k, v] of Object.entries(obj(L.achievements))) if (!achievements[k] || (v && v < achievements[k])) achievements[k] = v;
    const stats = {};
    for (const k of new Set([...Object.keys(SAVE_DEFAULTS.stats), ...Object.keys(obj(R.stats)), ...Object.keys(obj(L.stats))])) {
      stats[k] = Math.max(Number(obj(R.stats)[k]) || 0, Number(obj(L.stats)[k]) || 0);
    }
    const journey = [];
    for (const id of [].concat(R.journeyDone || [], L.journeyDone || [])) if (journey.indexOf(id) < 0) journey.push(id);
    return normalize(Object.assign({}, L, R, {
      journeyDone: journey,
      achievements: achievements,
      dailyResults: Object.assign({}, obj(L.dailyResults), obj(R.dailyResults)),
      streak: Math.max(Number(R.streak) || 0, Number(L.streak) || 0),
      bestStreak: Math.max(Number(R.bestStreak) || 0, Number(L.bestStreak) || 0),
      stats: stats,
      tutorialDone: !!(R.tutorialDone || L.tutorialDone)
    }));
  }

  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  /** Same content, key order ignored. */
  function same(a, b) { return canonical(normalize(a)) === canonical(normalize(b)); }

  /** The browser build's cloud slot (game:<slug>): session.encodeSave text, checksum verified; null if unreadable. */
  function readForeign(text) {
    if (typeof text !== 'string') return null;
    const parsed = session.decodeSave(text.trim());
    return parsed && parsed.data ? normalize(parsed.data) : null;
  }

  const ACHIEVEMENTS = [
    { key: 'first_win', name: 'First Win', desc: 'Win your first match.' },
    { key: 'first_goal', name: 'Off the Mark', desc: 'Score your first goal.' },
    { key: 'curve_master', name: 'Bender', desc: 'Score 3 curved goals.' },
    { key: 'keeper_10', name: 'Gloved', desc: 'Make 10 saves.' },
    { key: 'streak_3', name: 'Hat Trick', desc: 'Win 3 matches in a row.' },
    { key: 'journey_10', name: 'On the Road', desc: 'Complete 10 journey stages.' },
    { key: 'journey_40', name: 'Road Complete', desc: 'Finish all 40 journey stages.' },
    { key: 'daily_7', name: 'Regular', desc: 'Play 7 daily challenges.' }
  ];
  /** Idempotent unlock (js/ui.js unlockAchievement); returns the achievement if newly unlocked. */
  function unlock(save, key, now) {
    if (save.achievements[key]) return null;
    const def = ACHIEVEMENTS.find((a) => a.key === key);
    if (!def) return null;
    save.achievements[key] = now || 1;
    return def;
  }

  // ---- the game's own options (engine settings) ----
  const DEFAULT_OPTIONS = { theme: 'midnight', timingAssist: false, leftHanded: false, captions: true };
  const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
  /** The browser build's account settings keys (js/platform.js SYNCED_SETTINGS). */
  const BROWSER_KEYS = ['music', 'sfx', 'ambience', 'voice', 'gfx', 'theme', 'reducedMotion', 'highContrast',
    'largeText', 'leftHanded', 'timingAssist', 'hapticsOff', 'captions', 'cameraPref', 'tutorialDone'];
  /** A valid value for an option, or undefined. */
  function pickOption(key, v) {
    if (key === 'theme') return typeof v === 'string' && content.THEMES.some((t) => t.id === v) ? v : undefined;
    if (key === 'timingAssist' || key === 'leftHanded' || key === 'captions') return typeof v === 'boolean' ? v : undefined;
    return undefined;
  }
  /** The browser build's settings KV: the options that carry over and whether the tutorial was finished. */
  function readLegacySettings(kv) {
    const k = obj(kv), options = {};
    for (const key of OPTION_KEYS) {
      const v = pickOption(key, k[key]);
      if (v !== undefined) options[key] = v;
    }
    return { options: options, tutorialDone: k.tutorialDone === true };
  }

  return {
    SAVE_DEFAULTS: SAVE_DEFAULTS, ACHIEVEMENTS: ACHIEVEMENTS, DEFAULT_OPTIONS: DEFAULT_OPTIONS, OPTION_KEYS: OPTION_KEYS,
    BROWSER_KEYS: BROWSER_KEYS,
    normalize: normalize, mergeSaves: mergeSaves, same: same, readForeign: readForeign, unlock: unlock,
    pickOption: pickOption, readLegacySettings: readLegacySettings
  };
});
