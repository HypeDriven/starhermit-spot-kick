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
  const SCREENS = ['screen-loading', 'screen-title', 'screen-setup', 'screen-play', 'screen-results'];
  const OVERLAYS = ['overlay-pause', 'overlay-help'];

  let lastFocus = null;

  // ---------- screens ----------
  function show(id) {
    SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
    OVERLAYS.forEach(o => $(o).classList.add('hidden'));
    $('status-bar').classList.toggle('hidden', id !== 'screen-play');
    const first = $(id).querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }
  function openOverlay(id) {
    lastFocus = document.activeElement;
    $(id).classList.remove('hidden');
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
    quality: 'high', theme: 'midnight',
    reducedMotion: false, highContrast: false, largeText: false,
    leftHanded: false, timingAssist: false, hapticsOff: false, captions: true,
    cameraPref: 'auto', tutorialDone: false
  };
  let settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (_) { /* keep defaults */ }
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
      'opt-quality': 'quality', 'opt-theme': 'theme',
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
        announce('Setting changed: ' + el.closest('label')?.textContent?.trim()?.split(/\s{2,}/)[0] || key);
      });
    };
    wire('opt-music', 'music', e => +e.value); wire('opt-sfx', 'sfx', e => +e.value);
    wire('opt-ambience', 'ambience', e => +e.value); wire('opt-voice', 'voice', e => +e.value);
    wire('opt-quality', 'quality'); wire('opt-theme', 'theme');
    wire('opt-reduced-motion', 'reducedMotion', e => e.checked);
    wire('opt-high-contrast', 'highContrast', e => e.checked);
    wire('opt-large-text', 'largeText', e => e.checked);
    wire('opt-left-handed', 'leftHanded', e => e.checked);
    wire('opt-timing-assist', 'timingAssist', e => e.checked);
    wire('opt-haptics-off', 'hapticsOff', e => e.checked);
    wire('opt-captions', 'captions', e => e.checked);
  }
  function getSettings() { return settings; }

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
  function updateHud(state, ctx) {
    $('sb-mode').textContent = ctx.modeLabel || 'Spot Kick';
    $('sb-score').textContent = state.scoreA + ' – ' + state.scoreB + (state.suddenDeath ? ' (SD)' : '');
    $('hud-objective').textContent = ctx.objective || '';
    $('hud-phase').textContent = ctx.phaseText || '';
    $('sb-clock').textContent = ctx.clockText || '';
    const kicks = $('hud-kicks');
    kicks.innerHTML = '';
    state.log.forEach(rec => {
      const d = document.createElement('span');
      d.className = 'k ' + (rec.o === 'goal' ? 'goal' : rec.o === 'saved' ? 'saved' : 'off');
      d.title = 'Kick ' + rec.k + ' (' + rec.s + '): ' + rec.o;
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
  function renderResults(res) {
    $('results-headline').textContent = res.headline;
    const b = res.breakdown;
    const body = $('results-body');
    body.innerHTML = '';
    const table = el('table');
    table.innerHTML =
      '<tr><th>Component</th><th>' + res.nameA + '</th><th>' + res.nameB + '</th></tr>' +
      row('Goals', b.goals.A, b.goals.B) +
      row('Saves', b.saves.A, b.saves.B) +
      row('Perfect kicks', b.perfectKicks.A, b.perfectKicks.B) +
      row('Off target', b.offTarget.A, b.offTarget.B) +
      row('Invalid actions', b.invalidActions.A, b.invalidActions.B) +
      row('Kicks taken', b.kicks.A, b.kicks.B);
    body.appendChild(table);
    body.appendChild(el('p', 'dim',
      'Ended: ' + (b.terminalReason || '') + (b.suddenDeath ? ' · sudden death' : '') +
      (res.elapsedMs ? ' · ' + Math.round(res.elapsedMs / 1000) + 's' : '')));
    if (res.extra) body.appendChild(el('p', 'dim', res.extra));
    const ach = $('results-achievements');
    ach.innerHTML = '';
    (res.newAchievements || []).forEach(a => ach.appendChild(el('span', 'ach', '🏆 ' + a.name)));
    $('results-next').textContent = res.next || '';
    show('screen-results');
  }
  function row(label, a, b) {
    return '<tr><td>' + label + '</td><td>' + a + '</td><td>' + b + '</td></tr>';
  }

  // ---------- help: rule cards from current control mappings ----------
  function renderHelp(bindings) {
    const body = $('help-body');
    body.innerHTML = '';
    const cards = [
      ['Objective', 'Alternate shooting and goalkeeping across a five-kick set. Score more than your opponent; ties go to sudden death, kick for kick.'],
      ['Shooting', 'Pick a goal zone (left / center / right, low / high) and a curve. Curve shifts the ball one column late — it beats early dives but can miss the frame.'],
      ['Goalkeeping', 'Pick a zone and a timing. On-time saves the exact zone. Early covers a whole column against straight shots but is beaten by curve. Late saves nothing.'],
      ['Scoring', 'Results break down goals, saves, perfect kicks, off-target and invalid actions. Ties resolve by goals, then fewer invalid actions, then elapsed time.'],
      ['Keyboard', (bindings && bindings.length ? bindings.join(' · ') : 'Arrows: choose zone · Enter: confirm · Esc: pause · U: undo (practice) · C: camera')],
      ['Touch', 'Tap a goal zone to target it, then confirm. Drag gestures never required; every action is a single tap.']
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
    loadSettings: loadSettings, saveSettings: saveSettings, getSettings: getSettings, bindSettings: bindSettings,
    loadSave: loadSave, persistSave: persistSave, getSave: getSave,
    ACHIEVEMENTS: ACHIEVEMENTS, unlockAchievement: unlockAchievement,
    updateHud: updateHud, setPanels: setPanels, setWaitText: setWaitText, setSelection: setSelection,
    setupView: setupView, renderResults: renderResults, renderHelp: renderHelp,
    setJourneyProgress: setJourneyProgress, setProfileLine: setProfileLine,
    setLoadingStatus: setLoadingStatus, showCompat: showCompat
  };
});
