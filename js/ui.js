'use strict';

/*
 * Spot Kick UI — responsive DOM shell, screen manager, settings, persistence,
 * help cards, results rendering, accessibility mirror (live regions, captions).
 * UI state is fully separate from simulation state.
 */
(function (root, factory) {
  const session = (typeof module !== 'undefined' && module.exports) ? require('./session') : root.SpotKickSession;
  const api = factory(session);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickUI = api;
})(typeof self !== 'undefined' ? self : this, function (session) {

  const $ = (id) => document.getElementById(id);
  // Text goes through SKI18N (js/i18n.js); English source strings are the keys.
  const T = (key, vars) => ((typeof self !== 'undefined' && self.SKI18N) ? self.SKI18N.T(key, vars)
    : String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
  const txt = (v) => (typeof v === 'function' ? v() : (v == null ? '' : v));
  const SCREENS = ['screen-loading', 'screen-title', 'screen-setup', 'screen-play', 'screen-results'];
  const OVERLAYS = ['overlay-pause', 'overlay-help', 'overlay-expired'];

  let lastFocus = null;

  // ---------- screens ----------
  function show(id) {
    SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
    OVERLAYS.forEach(o => $(o).classList.add('hidden'));
    $('status-bar').classList.toggle('hidden', id !== 'screen-play');
    $(id).scrollTop = 0; // hidden screens keep their scroll; reopen at the top
    const first = $(id).querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }
  function openOverlay(id) {
    lastFocus = document.activeElement;
    $(id).classList.remove('hidden');
    $(id).scrollTop = 0;
    const first = $(id).querySelector('button:not([disabled]), input, select');
    if (first) first.focus({ preventScroll: true });
  }
  function closeOverlay(id) {
    $(id).classList.add('hidden');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
  function currentScreen() {
    return SCREENS.find(s => !$(s).classList.contains('hidden')) || null;
  }
  function anyOverlayOpen() { return OVERLAYS.some(o => !$(o).classList.contains('hidden')); }

  // ---------- accessibility mirror ----------
  function announce(text) { $('live-region').textContent = text; }
  let toastTimer = null;
  function toast(text) {
    const el = $('sh-toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
    announce(text);
  }
  function alertUser(text) { $('alert-region').textContent = text; }
  function caption(text) {
    const el = $('captions');
    if (!text || !settings.captions) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  // ---------- settings ----------
  const SETTINGS_KEY = 'spotkick.settings.v1';
  const DEFAULTS = {
    music: 60, sfx: 80, ambience: 50, voice: 80,
    gfx: {}, theme: 'midnight', // gfx: Graphics panel state (see gfx.js); {} = Auto
    reducedMotion: false, highContrast: false, largeText: false,
    leftHanded: false, timingAssist: false, hapticsOff: false, captions: true,
    cameraPref: 'auto', tutorialDone: false
  };
  let settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
      delete settings.quality; // superseded by gfx
    } catch (_) { /* keep defaults */ }
    settings.gfx = Object.assign({}, settings.gfx && typeof settings.gfx === 'object' ? settings.gfx : {});
    applySettings();
    syncSettingsInputs();
    return settings;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }
  function applySettings() {
    document.body.classList.toggle('high-contrast', !!settings.highContrast);
    document.body.classList.toggle('large-text', !!settings.largeText);
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
  }
  function syncSettingsInputs() {
    const map = {
      'opt-music': 'music', 'opt-sfx': 'sfx', 'opt-ambience': 'ambience', 'opt-voice': 'voice',
      'opt-theme': 'theme',
      'opt-reduced-motion': 'reducedMotion', 'opt-high-contrast': 'highContrast',
      'opt-large-text': 'largeText', 'opt-left-handed': 'leftHanded',
      'opt-timing-assist': 'timingAssist', 'opt-haptics-off': 'hapticsOff', 'opt-captions': 'captions'
    };
    for (const id of Object.keys(map)) {
      const el = $(id); if (!el) continue;
      const key = map[id];
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
      updateOutput(el);
    }
  }
  function updateOutput(el) {
    if (el.type !== 'range') return;
    const out = el.parentElement.querySelector('output');
    if (out) out.value = el.value + '%';
  }
  function bindSettings(onChange) {
    const wire = (id, key, parse) => {
      const el = $(id); if (!el) return;
      el.addEventListener('input', () => {
        settings[key] = parse ? parse(el) : el.value;
        updateOutput(el);
        applySettings(); saveSettings();
        if (onChange) onChange(key, settings[key]);
        announce(T('Setting changed: {name}', { name: el.closest('label')?.textContent?.trim()?.split(/\s{2,}/)[0] || key }));
      });
    };
    wire('opt-music', 'music', e => +e.value); wire('opt-sfx', 'sfx', e => +e.value);
    wire('opt-ambience', 'ambience', e => +e.value); wire('opt-voice', 'voice', e => +e.value);
    wire('opt-theme', 'theme');
    wire('opt-reduced-motion', 'reducedMotion', e => e.checked);
    wire('opt-high-contrast', 'highContrast', e => e.checked);
    wire('opt-large-text', 'largeText', e => e.checked);
    wire('opt-left-handed', 'leftHanded', e => e.checked);
    wire('opt-timing-assist', 'timingAssist', e => e.checked);
    wire('opt-haptics-off', 'hapticsOff', e => e.checked);
    wire('opt-captions', 'captions', e => e.checked);
  }
  function getSettings() { return settings; }
  function getGfx() { return settings.gfx; }
  function setGfx(g) { settings.gfx = Object.assign({}, g); saveSettings(); }

  // ---------- persistent save (versioned + checksummed) ----------
  const SAVE_KEY = 'spotkick.save.v1';
  const SAVE_DEFAULTS = {
    journeyDone: [], achievements: {}, dailyResults: {},
    streak: 0, bestStreak: 0, stats: { goals: 0, saves: 0, curvedGoals: 0, wins: 0, matches: 0, dailies: 0 }
  };
  let save = Object.assign({}, SAVE_DEFAULTS);

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = session.decodeSave(raw);
        if (parsed && parsed.data) save = Object.assign({}, SAVE_DEFAULTS, parsed.data);
      }
    } catch (_) { /* corrupted save -> defaults, never crash */ }
    return save;
  }
  /**
   * Merge two save docs without dropping either side: finished journey stages
   * and achievements are unioned (earliest unlock kept), daily results keep
   * whichever was recorded (the cloud copy first), the streak, best streak and
   * every stat keep the larger value. Either side may be null.
   */
  function mergeSaves(remote, local) {
    const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    const R = Object.assign({}, SAVE_DEFAULTS, obj(remote)), L = Object.assign({}, SAVE_DEFAULTS, obj(local));
    const achievements = Object.assign({}, obj(R.achievements));
    for (const [k, v] of Object.entries(obj(L.achievements))) if (!achievements[k] || (v && v < achievements[k])) achievements[k] = v;
    const stats = {};
    for (const k of new Set([...Object.keys(SAVE_DEFAULTS.stats), ...Object.keys(obj(R.stats)), ...Object.keys(obj(L.stats))])) {
      stats[k] = Math.max(Number(obj(R.stats)[k]) || 0, Number(obj(L.stats)[k]) || 0);
    }
    const journey = [];
    for (const id of [].concat(R.journeyDone || [], L.journeyDone || [])) if (journey.indexOf(id) < 0) journey.push(id);
    return Object.assign({}, L, R, {
      journeyDone: journey,
      achievements: achievements,
      dailyResults: Object.assign({}, obj(L.dailyResults), obj(R.dailyResults)),
      streak: Math.max(Number(R.streak) || 0, Number(L.streak) || 0),
      bestStreak: Math.max(Number(R.bestStreak) || 0, Number(L.bestStreak) || 0),
      stats: stats
    });
  }
  // A cloud doc (already checksum-verified) is merged into the local save.
  function adoptSave(doc) {
    save = mergeSaves(doc, save);
    persistSave();
    return save;
  }
  function persistSave() {
    try { localStorage.setItem(SAVE_KEY, session.encodeSave(save)); } catch (_) {}
  }
  function getSave() { return save; }

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

  // Idempotent unlock; returns the achievement if newly unlocked.
  function unlockAchievement(key) {
    if (save.achievements[key]) return null;
    const def = ACHIEVEMENTS.find(a => a.key === key);
    if (!def) return null;
    save.achievements[key] = Date.now();
    persistSave();
    return def;
  }

  // ---------- HUD ----------
  const OUTCOME = { goal: 'goal', saved: 'saved', off: 'off target', offtarget: 'off target', miss: 'off target' };
  function updateHud(state, ctx) {
    $('sb-mode').textContent = ctx.modeLabel || 'Spot Kick';
    $('sb-score').textContent = state.scoreA + ' – ' + state.scoreB + (state.suddenDeath ? ' ' + T('(SD)') : '');
    $('hud-objective').textContent = ctx.objective || '';
    $('hud-phase').textContent = ctx.phaseText || '';
    $('sb-clock').textContent = ctx.clockText || '';
    const kicks = $('hud-kicks');
    kicks.setAttribute('aria-label', T('Kick progress'));
    kicks.innerHTML = '';
    state.log.forEach(rec => {
      const d = document.createElement('span');
      d.className = 'k ' + (rec.o === 'goal' ? 'goal' : rec.o === 'saved' ? 'saved' : 'off');
      d.title = T('Kick {n} ({side}): {outcome}', { n: rec.k, side: rec.s, outcome: T(OUTCOME[rec.o] || 'off target') });
      kicks.appendChild(d);
    });
  }

  function setPanels(which) {
    $('panel-shoot').classList.toggle('hidden', which !== 'shoot');
    $('panel-dive').classList.toggle('hidden', which !== 'dive');
    $('panel-wait').classList.toggle('hidden', which !== 'wait' && which !== null);
    if (which === null) $('wait-text').textContent = '';
  }
  function setWaitText(t) { $('wait-text').textContent = t; }
  function setSelection(kind, text, canConfirm) {
    if (kind === 'shoot') {
      $('shoot-selection').textContent = text;
      $('btn-confirm-shot').disabled = !canConfirm;
    } else {
      $('dive-selection').textContent = text;
      $('btn-confirm-dive').disabled = !canConfirm;
    }
  }

  // ---------- setup screen builders ----------
  function setupView(title, rulesText, bodyNode) {
    $('setup-title').textContent = title;
    $('setup-rules').textContent = rulesText;
    const body = $('setup-body');
    body.innerHTML = '';
    if (bodyNode) body.appendChild(bodyNode);
    show('screen-setup');
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ---------- results ----------
  /** Results screen; text fields may be thunks so a language change can redraw in place. */
  let lastResults = null;
  function renderResults(res, relabel) {
    lastResults = res;
    $('results-headline').textContent = txt(res.headline);
    const b = res.breakdown;
    const body = $('results-body');
    body.innerHTML = '';
    if (b) {
      const table = el('table');
      const esc = (v) => String(v).replace(/[<>&]/g, '');
      table.innerHTML =
        '<tr><th>' + esc(T('Component')) + '</th><th>' + esc(txt(res.nameA)) + '</th><th>' + esc(txt(res.nameB)) + '</th></tr>' +
        row(T('Goals'), b.goals.A, b.goals.B) +
        row(T('Saves'), b.saves.A, b.saves.B) +
        row(T('Perfect kicks'), b.perfectKicks.A, b.perfectKicks.B) +
        row(T('Off target'), b.offTarget.A, b.offTarget.B) +
        row(T('Invalid actions'), b.invalidActions.A, b.invalidActions.B) +
        row(T('Kicks taken'), b.kicks.A, b.kicks.B);
      body.appendChild(table);
      body.appendChild(el('p', 'dim',
        T('Ended: {reason}', { reason: T(TERMINAL[b.terminalReason] || b.terminalReason || '') }) + (b.suddenDeath ? ' · ' + T('sudden death') : '') +
        (res.elapsedMs ? ' · ' + Math.round(res.elapsedMs / 1000) + 's' : '')));
    }
    if (res.extra) body.appendChild(el('p', 'dim', txt(res.extra)));
    if (res.lb) { const line = el('p', null, txt(res.lb)); line.id = 'results-lb'; line.setAttribute('aria-live', 'polite'); body.appendChild(line); }
    if (res.board) appendBoard(res.board.title, res.board.entries, res.board.me, true);
    const ach = $('results-achievements');
    ach.innerHTML = '';
    (res.newAchievements || []).forEach(a => ach.appendChild(el('span', 'ach', '🏆 ' + T(a.name))));
    $('results-next').textContent = txt(res.next);
    if (!relabel) show('screen-results');
  }
  // Terminal reasons from rules.js, shown on the results screen.
  const TERMINAL = { 'mathematical': 'decided before the last kick', 'decided-regular': 'after regulation kicks', 'decided-sudden-death': 'in sudden death' };
  function row(label, a, b) {
    return '<tr><td>' + label + '</td><td>' + a + '</td><td>' + b + '</td></tr>';
  }
  /** Redraw the open results screen in the current language (no state change). */
  function relabelResults() {
    if (lastResults && !$('screen-results').classList.contains('hidden')) renderResults(lastResults, true);
  }

  // Read-only platform board (hosted mode), appended when the fetch resolves.
  function appendBoard(title, entries, me, redraw) {
    const body = $('results-body');
    if (!body || !entries || !entries.length) return;
    if (!redraw && lastResults) lastResults.board = { title: title, entries: entries, me: me };
    body.appendChild(el('h3', null, T(title)));
    const table = el('table');
    table.className = 'board';
    let html = '<tr><th>#</th><th>' + T('Player') + '</th><th>' + T('Score') + '</th></tr>';
    entries.slice(0, 10).forEach((r, i) => {
      html += '<tr' + (r.you ? ' class="you"' : '') + '><td>' + (r.rank || (i + 1)) + '</td><td>' +
        String(r.name || T('Player')).replace(/[<>&]/g, '') + (r.you ? ' ' + T('(you)') : '') + '</td><td>' + r.score + '</td></tr>';
    });
    if (me && typeof me.score === 'number') {
      html += '<tr class="you"><td>' + (me.rank || '–') + '</td><td>' + T('You') + '</td><td>' + me.score + '</td></tr>';
    }
    table.innerHTML = html;
    body.appendChild(table);
  }

  // ---------- help: rule cards from current control mappings ----------
  function renderHelp(bindings) {
    const body = $('help-body');
    body.innerHTML = '';
    const cards = [
      [T('Objective'), T('Alternate shooting and goalkeeping across a five-kick set. Score more than your opponent; ties go to sudden death, kick for kick.')],
      [T('Shooting'), T('Pick a goal zone (left / center / right, low / high) and a curve. Curve shifts the ball one column late — it beats early dives but can miss the frame.')],
      [T('Goalkeeping'), T('Pick a zone and a timing. On-time saves the exact zone. Early covers a whole column against straight shots but is beaten by curve. Late saves nothing.')],
      [T('Scoring'), T('Results break down goals, saves, perfect kicks, off-target and invalid actions. Ties resolve by goals, then fewer invalid actions, then elapsed time.')],
      [T('Keyboard'), (bindings && bindings.length ? bindings.join(' · ') : T('Arrows: choose zone · Enter: confirm · Esc: pause · U: undo (practice) · C: camera'))],
      [T('Touch'), T('Tap a goal zone to target it, then confirm. Drag gestures never required; every action is a single tap.')]
    ];
    cards.forEach(([h, t]) => {
      const c = el('div', 'help-card');
      c.appendChild(el('h3', null, h));
      c.appendChild(el('p', null, t));
      body.appendChild(c);
    });
  }

  function setJourneyProgress(done, total) {
    $('journey-progress').textContent = done + '/' + total;
  }
  function setProfileLine(text) { $('title-profile').textContent = text; }
  function setLoadingStatus(text) { $('loading-status').textContent = text; }
  function showCompat() { $('compat-message').classList.remove('hidden'); }

  return {
    $: $, el: el,
    show: show, openOverlay: openOverlay, closeOverlay: closeOverlay,
    currentScreen: currentScreen, anyOverlayOpen: anyOverlayOpen,
    announce: announce, alertUser: alertUser, caption: caption,
    loadSettings: loadSettings, saveSettings: saveSettings, getSettings: getSettings, getGfx: getGfx, setGfx: setGfx, bindSettings: bindSettings,
    loadSave: loadSave, persistSave: persistSave, getSave: getSave, adoptSave: adoptSave, mergeSaves: mergeSaves,
    relabelResults: relabelResults, T: T,
    ACHIEVEMENTS: ACHIEVEMENTS, unlockAchievement: unlockAchievement,
    updateHud: updateHud, setPanels: setPanels, setWaitText: setWaitText, setSelection: setSelection,
    setupView: setupView, renderResults: renderResults, renderHelp: renderHelp, appendBoard: appendBoard,
    setJourneyProgress: setJourneyProgress, setProfileLine: setProfileLine, toast: toast,
    setLoadingStatus: setLoadingStatus, showCompat: showCompat
  };
});
