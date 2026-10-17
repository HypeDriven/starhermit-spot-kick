'use strict';

/*
 * Spot Kick bootstrap — host handshake, capability detection, lifecycle, and
 * the game controller wiring rules/session/render/ui/audio/content/platform.
 *
 * State machine: boot → title → mode-select → preparing → countdown →
 * active ↔ paused → resolving → results → progression.
 */
(function () {
  const rules = window.SpotKickRules;
  const content = window.SpotKickContent;
  const session = window.SpotKickSession;
  const audio = window.SpotKickAudio;
  const render = window.SpotKickRender;
  const platform = window.SpotKickPlatform;
  const rooms = window.SpotKickRooms;
  const ui = window.SpotKickUI;

  const BUILD = '1.0.0';

  // Text goes through SKI18N (js/i18n.js); English source strings are the keys.
  const T = (key, vars) => (window.SKI18N ? window.SKI18N.T(key, vars)
    : String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
  const gameLang = () => (window.SKI18N ? window.SKI18N.lang : 'en-US');
  // Mode labels are thunks so the HUD and status bar follow a language change.
  const ml = (c) => (c && c.modeLabel ? (typeof c.modeLabel === 'function' ? c.modeLabel() : c.modeLabel) : '');
  // Player-facing words for rule values (rules.js / content.js data stay English).
  const WORD = {
    left: 'left', center: 'center', right: 'right', high: 'high', low: 'low', none: 'none',
    early: 'early', on: 'on time', late: 'late',
  };
  const GOAL = { win: 'win', 'win-by-2': 'win by 2', 'clean-sheet': 'clean sheet' };
  const w = (v) => T(WORD[v] || v);
  const zoneName = (z) => T('{dir} {height}', { dir: w(z.dir), height: w(z.height) });
  /** Localized journey stage name (content.js builds "Stage N" / "Stage N — Mastery"). */
  const stageName = (st) => (/Mastery/.test(st.name) ? T('Stage {n} — Mastery', { n: st.index }) : T('Stage {n}', { n: st.index }));
  // ---------- controller state (UI-side, separate from sim state) ----------
  const G = {
    appState: 'boot',
    mode: null,              // play|daily|journey|practice|challenge|learn|hosted
    config: null,            // current stage/challenge/daily config
    match: null,             // session object (local) or hosted descriptor
    humanSides: ['A'],       // which sides this device controls
    aiSide: 'B',
    hotseat: false,
    sel: { zone: null, curve: 'none', timing: 'on' },
    kbCursor: { dir: 'center', height: 'low' },
    resolving: false,
    countdownTimer: null,
    decisionDeadline: 0,
    pausedAt: 0,
    decisionTimer: null,
    learnStep: 0,
    hosted: null,            // {code, token, side, pollTimer, lastTick}
    paused: false,
    pendingAfterAnim: null
  };

  const $ = ui.$;

  // ---------- boot ----------
  function boot() {
    ui.setLoadingStatus(T('Checking content…'));
    const check = content.validateContent();
    if (!check.ok) console.error('Content validation failed:', check.errors);

    ui.loadSettings();
    ui.loadSave();
    fillThemeSelect();
    ui.renderHelp(keyboardBindings());

    const canvas = $('game-canvas');
    // canvas MSAA is a context attribute: skip it only when the saved choice explicitly avoids MSAA
    const gSaved = ui.getGfx();
    const gfxModel = window.SpotKickGfx;
    const explicitAA = gfxModel.PRESETS.indexOf(gSaved.preset) >= 0 || gfxModel.CATEGORIES.antialias.indexOf(gSaved.antialias) >= 0;
    const antialias = !explicitAA || gfxModel.resolve(gSaved, 'balanced').antialias === 'msaa';
    const ok = render.init(canvas, { onPick: onZonePick, onHover: onZoneHover, antialias: antialias });
    if (!ok) { ui.showCompat(); return; }
    applyVisualSettings();
    render.setTheme(currentTheme());

    wireUi();
    wireInput();
    wireAccount();
    ui.bindSettings(onSettingChange);
    window.SpotKickGfxPanel.init({
      lang: gameLang(),
      render: render, getSaved: ui.getGfx, save: ui.setGfx,
      onChange: () => onSettingChange('gfx')
    });
    platform.syncTime(); // signed in only (platform time); standalone uses the local clock

    // Hosted boot: resolve the account nickname, then adopt the cloud save
    // (remote wins) before the profile line and journey counts render.
    platform.onSync(() => { if (G.appState === 'title') ui.setProfileLine(profileLine()); });
    if (platform.hosted()) {
      ui.setLoadingStatus(T('Connecting to your account…'));
      // Another device saved first: reload, merge with this device's save and write the merge.
      platform.onConflict((remote) => {
        adoptRemoteSave(remote, true);
        if (G.appState === 'title') ui.setProfileLine(profileLine());
      });
      platform.initHosted().then((remote) => {
        applyPlatformSettings();
        adoptRemoteSave(remote, false);
        ui.setJourneyProgress(ui.getSave().journeyDone.length, content.JOURNEY.length);
        ui.setProfileLine(profileLine());
      });
    }

    ui.setJourneyProgress(ui.getSave().journeyDone.length, content.JOURNEY.length);
    ui.setProfileLine(profileLine());

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    onResize();

    setAppState('title');
    ui.show('screen-title');
    requestAnimationFrame(loop);
  }

  /**
   * Merge a cloud save doc (encoded string) into the local save (ui.mergeSaves:
   * union of stages and achievements, max stats/streaks) and upload the merge
   * when the cloud lacked anything this device has.
   */
  function adoptRemoteSave(remote, afterConflict) {
    let data = null;
    if (remote) {
      try {
        const parsed = session.decodeSave(remote);
        if (parsed && parsed.data) data = parsed.data;
      } catch (_) { /* malformed remote doc: local cache stays */ }
    }
    const before = JSON.stringify(ui.mergeSaves(data, null));
    ui.adoptSave(data);
    const changed = JSON.stringify(ui.getSave()) !== before;
    if (changed || afterConflict) platform.queueCloudSave(session.encodeSave(ui.getSave()));
  }

  function setAppState(s, reason) {
    G.appState = s;
    document.body.dataset.state = s;
    if (reason) console.info('[state]', s, '—', reason);
  }

  // ---------- StarHermit: settings KV, sign-in / invite, sign-out ----------
  // StarHermit account strings in the current game language (sh-strings.js).
  const SHT = () => window.SpotKickShStrings.strings(gameLang());
  let platformSettingsApplied = false;

  // Signed in: the platform's settings win over the local ones; afterwards
  // every change is mirrored to the platform KV.
  function applyPlatformSettings() {
    platform.loadSettings().then((remote) => {
      const s = ui.getSettings();
      Object.assign(s, remote);
      if (remote.gfx) s.gfx = Object.assign({}, remote.gfx);
      ui.saveSettings();
      ui.loadSettings(); // re-apply classes + sync the inputs from storage
      applyVisualSettings();
      render.setTheme(currentTheme());
      ['music', 'sfx', 'ambience', 'voice'].forEach((k) => audio.setLevel(k, ui.getSettings()[k] / 100));
      if (window.SpotKickGfxPanel.sync) window.SpotKickGfxPanel.sync();
      platformSettingsApplied = true;
      platform.pushSettings(ui.getSettings());
    });
  }

  function refreshAccount() {
    document.getElementById('btn-signin').classList.toggle('hidden', !platform.canSignIn());
    document.getElementById('btn-invite').classList.toggle('hidden', !platform.inviteLink());
    // Online matches use StarHermit realtime rooms: signed in only.
    document.getElementById('btn-hosted').classList.toggle('hidden', !platform.hosted());
  }

  // The relaunch overlay explains why: an expired session or pending terms consent.
  let expiredReason = 'expired';
  function labelAccount() {
    const L = SHT();
    document.getElementById('btn-signin').textContent = L.signIn;
    document.getElementById('btn-invite').textContent = L.invite;
    document.getElementById('expired-heading').textContent = expiredReason === 'terms' ? L.termsTitle : L.expiredTitle;
    document.getElementById('expired-body').textContent = expiredReason === 'terms' ? L.termsBody : L.expiredBody;
    document.getElementById('btn-relaunch').textContent = L.relaunch;
    document.getElementById('btn-expired-local').textContent = L.playLocal;
  }
  function wireAccount() {
    labelAccount();
    platform.onSignedOut(() => {
      // A refused renewal before a room reconnect shows the expired overlay instead.
      const renewing = G.hosted && G.hosted.client && G.hosted.client.renewing;
      if (!renewing) ui.toast(SHT().signedOut);
      refreshAccount();
      if (G.appState === 'title') ui.setProfileLine(profileLine());
    });
    refreshAccount();
  }

  async function copyInvite() {
    const link = platform.inviteLink();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); ui.toast(SHT().copied); }
    catch (_) { ui.toast(SHT().copyFailed + ': ' + link); }
  }

  function profileLine() {
    const s = ui.getSave();
    const wins = s.stats.wins, m = s.stats.matches;
    const stats = m ? T('{wins} wins in {matches} matches · best streak {streak}', { wins: wins, matches: m, streak: s.bestStreak }) : null;
    if (platform.hosted()) {
      const sync = T({ saving: 'saving…', synced: 'synced', offline: 'offline' }[platform.getSyncStatus()] || 'offline');
      return T('Playing as {name} · cloud save {sync}', { name: platform.displayName() || '…', sync: sync }) + (stats ? ' · ' + stats : '');
    }
    return m ? (T('Guest profile') + ' · ' + stats) : T('Guest profile — progress is stored on this device');
  }

  function currentTheme() {
    const s = ui.getSettings();
    if (s.highContrast) return content.THEMES.find(t => t.id === 'mono');
    return content.THEMES.find(t => t.id === s.theme) || content.THEMES[0];
  }

  function fillThemeSelect() {
    const sel = $('opt-theme');
    const keep = sel.value;
    sel.innerHTML = '';
    content.THEMES.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = T(t.name);
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
  }

  function applyVisualSettings() {
    const s = ui.getSettings();
    render.setGraphics(s.gfx);
    render.setReducedMotion(s.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    audio.setLevel('music', s.music / 100);
    audio.setLevel('sfx', s.sfx / 100);
    audio.setLevel('ambience', s.ambience / 100);
    audio.setLevel('voice', s.voice / 100);
  }

  function onSettingChange(key, value) {
    if (key === 'theme') { render.setTheme(currentTheme()); }
    if (key === 'highContrast') render.setTheme(currentTheme());
    if (key === 'reducedMotion') applyVisualSettings();
    if (['music', 'sfx', 'ambience', 'voice'].indexOf(key) >= 0) audio.setLevel(key, value / 100);
    audio.event('ui-confirm');
    funnel('settings-change', { key: key });
    if (platformSettingsApplied) platform.pushSettings(ui.getSettings());
  }

  // ---------- input wiring ----------
  function wireUi() {
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      audio.unlock();
      handleAction(btn.dataset.action, btn);
    });
    document.querySelectorAll('[data-zone]').forEach(b => b.addEventListener('click', () => {
      const parts = b.dataset.zone.split(':');
      onZonePick({ dir: parts[0], height: parts[1] });
    }));
    document.querySelectorAll('[data-curve]').forEach(b => b.addEventListener('click', () => {
      audio.unlock();
      G.sel.curve = b.dataset.curve;
      markSeg('curve', G.sel.curve);
      updateSelectionUi();
      audio.event('ui-confirm');
    }));
    document.querySelectorAll('[data-timing]').forEach(b => b.addEventListener('click', () => {
      audio.unlock();
      G.sel.timing = b.dataset.timing;
      markSeg('timing', G.sel.timing);
      updateSelectionUi();
      audio.event('ui-confirm');
    }));
    audio.onCaption((t) => ui.caption(t ? T(t) : t)); // audio.js captions are English keys
  }

  function markSeg(kind, val) {
    document.querySelectorAll('[data-' + kind + ']').forEach(b => {
      const on = b.dataset[kind] === val;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function keyboardBindings() {
    const k = platform.keyLabel;
    return [
      T('{keys}: move zone cursor', { keys: k('left') + ' ' + k('right') + ' ' + k('high') + ' ' + k('low') }),
      T('{keys}: select zone or confirm', { keys: k('confirm') }),
      T('{keys}: curve', { keys: k('curveLeft') + '/' + k('curveRight') }), T('{keys}: dive timing', { keys: k('early') + '/' + k('onTime') + '/' + k('late') }),
      T('{keys}: pause', { keys: k('pause') }), T('{keys}: undo (practice)', { keys: k('undo') }),
      T('{keys}: help', { keys: k('help') }), T('{keys}: reset camera', { keys: k('camera') }), T('{keys}: skip animation', { keys: k('skip') })
    ];
  }

  function wireInput() {
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const playing = G.appState === 'active' && !ui.anyOverlayOpen();
    const action = platform.actionFor(e.code);
    if (action === 'pause') {
      if (ui.anyOverlayOpen()) { ui.closeOverlay('overlay-help'); ui.closeOverlay('overlay-pause'); if (G.appState === 'paused') resume(); }
      else if (playing) pause();
      return;
    }
    if (action === 'help') { ui.renderHelp(keyboardBindings()); ui.openOverlay('overlay-help'); return; }
    if (!playing) return;
    const cols = rules.COLUMNS;
    let i = cols.indexOf(G.kbCursor.dir);
    if (action === 'left') i = Math.max(0, i - 1);
    else if (action === 'right') i = Math.min(cols.length - 1, i + 1);
    else if (action === 'high') G.kbCursor.height = 'high';
    else if (action === 'low') G.kbCursor.height = 'low';
    else if (action === 'curveLeft') cycleCurve(-1);
    else if (action === 'curveRight') cycleCurve(1);
    else if (action === 'early') setTiming('early');
    else if (action === 'onTime') setTiming('on');
    else if (action === 'late') setTiming('late');
    else if (action === 'undo') { doUndo(); return; }
    else if (action === 'camera') { resetCamera(); return; }
    else if (action === 'skip') { skipAnim(); return; }
    else if (action === 'confirm') {
      if (G.sel.zone) { confirmSelection(); }
      else onZonePick(G.kbCursor);
      e.preventDefault();
      return;
    } else return;
    G.kbCursor.dir = cols[i];
    render.showZoneHighlight(G.kbCursor);
    audio.event('ui-focus');
    e.preventDefault();
  }

  function cycleCurve(d) {
    const cs = rules.CURVES;
    const i = (cs.indexOf(G.sel.curve) + d + cs.length) % cs.length;
    G.sel.curve = cs[i];
    markSeg('curve', G.sel.curve);
    updateSelectionUi();
  }
  function setTiming(t) { G.sel.timing = t; markSeg('timing', t); updateSelectionUi(); }

  // ---------- gamepad (minimal: navigate, confirm, pause) ----------
  let padPrev = {};
  function pollGamepad() {
    if (!navigator.getGamepads) return;
    const gp = navigator.getGamepads()[0];
    if (!gp) return;
    const press = (i) => gp.buttons[i] && gp.buttons[i].pressed && !padPrev[i];
    if (press(9)) { if (G.appState === 'active') pause(); else if (G.appState === 'paused') resume(); }
    if (G.appState === 'active' && !ui.anyOverlayOpen()) {
      if (press(14)) moveCursor(-1, 0);
      if (press(15)) moveCursor(1, 0);
      if (press(12)) moveCursor(0, 1);
      if (press(13)) moveCursor(0, -1);
      if (press(0)) { if (G.sel.zone) confirmSelection(); else onZonePick(G.kbCursor); }
      if (press(1)) doUndo();
    }
    padPrev = {};
    gp.buttons.forEach((b, i) => { padPrev[i] = b.pressed; });
  }
  function moveCursor(dx, dy) {
    const cols = rules.COLUMNS;
    let i = cols.indexOf(G.kbCursor.dir) + dx;
    G.kbCursor.dir = cols[Math.max(0, Math.min(cols.length - 1, i))];
    if (dy > 0) G.kbCursor.height = 'high';
    if (dy < 0) G.kbCursor.height = 'low';
    render.showZoneHighlight(G.kbCursor);
  }

  // ---------- action dispatch ----------
  function handleAction(action, btn) {
    switch (action) {
      case 'play': setupPlay(); break;
      case 'daily': setupDaily(); break;
      case 'journey': setupJourney(); break;
      case 'practice': setupPractice(); break;
      case 'challenge': setupChallenge(); break;
      case 'learn': startLearn(); break;
      case 'hosted': setupHosted(); break;
      case 'help': ui.renderHelp(keyboardBindings()); ui.openOverlay('overlay-help'); audio.event('ui-confirm'); break;
      case 'settings': labelPauseOverlay(false); ui.openOverlay('overlay-pause'); break;
      case 'sh-signin': platform.signIn(); break;
      case 'sh-invite': copyInvite(); break;
      case 'sh-relaunch': if (!platform.relaunch()) ui.toast(SHT().signedOut); break;
      case 'expired-close': ui.closeOverlay('overlay-expired'); break;
      case 'start-match': startConfiguredMatch(); break;
      case 'back-to-menu': leaveToTitle(); break;
      case 'pause': pause(); break;
      case 'resume': resume(); break;
      case 'leave': leaveToTitle(); break;
      case 'skip': skipAnim(); break;
      case 'undo': doUndo(); break;
      case 'camera-reset': resetCamera(); break;
      case 'confirm-shot': confirmSelection(); break;
      case 'confirm-dive': confirmSelection(); break;
      case 'replay': replayMatch(); break;
      case 'next-match': nextMatch(); break;
      case 'close-help': ui.closeOverlay('overlay-help'); audio.event('ui-back'); break;
      case 'replay-tutorial': ui.closeOverlay('overlay-pause'); startLearn(); break;
    }
  }

  // ---------- mode setup screens ----------
  // The open setup screen's builder: a language change rebuilds it with the same choice.
  let setupRedraw = null;
  function setupPlay(relabel) {
    setupRedraw = () => setupPlay(true);
    setAppState('mode-select');
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', T('A five-kick shootout. You shoot first, then guard the goal.')));
    const vs = ui.el('div', 'seg');
    const aiBtn = ui.el('button', G.hotseat && relabel ? null : 'on', T('Vs AI (Club)'));
    const p2Btn = ui.el('button', G.hotseat && relabel ? 'on' : null, T('Two players · this device'));
    aiBtn.onclick = () => { G.hotseat = false; aiBtn.classList.add('on'); p2Btn.classList.remove('on'); };
    p2Btn.onclick = () => { G.hotseat = true; p2Btn.classList.add('on'); aiBtn.classList.remove('on'); };
    vs.append(aiBtn, p2Btn);
    body.appendChild(vs);
    if (!relabel) G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: () => T('Quick Match') };
    $('btn-start-match').disabled = false;
    ui.setupView(T('Quick Match'), T('Five kicks each · sudden death on ties · about 3 minutes · unranked'), body);
    if (!relabel) audio.event('ui-confirm');
  }

  function setupDaily(relabel) {
    setupRedraw = () => setupDaily(true);
    setAppState('mode-select');
    const day = content.utcDay(new Date(platform.now()));
    const d = content.dailyFor(day);
    const done = ui.getSave().dailyResults[day];
    const hosted = platform.hosted();
    const body = ui.el('div');
    body.appendChild(ui.el('p', null, T('Seed: {seed} · {day} (UTC)', { seed: d.seed.toString(16), day: day })));
    body.appendChild(ui.el('p', 'dim', done
      ? T(done.won ? 'Played today: won {score}. You can replay, but the recorded result stands.' : 'Played today: lost {score}. You can replay, but the recorded result stands.', { score: done.score })
      : (hosted
        ? T('One shared seed for everyone today. Your first result is recorded to your profile.')
        : T('One shared seed for everyone today. First result is ranked.'))));
    G.config = Object.assign({ modeLabel: () => T('Daily Challenge'), daily: d, ranked: !done }, d);
    $('btn-start-match').disabled = false;
    ui.setupView(T('Daily Challenge'), [T('Five kicks · Club keeper'),
      hosted ? T('first result recorded per UTC day') : T('ranked once per UTC day'),
      d.excluded ? T('excluded from the board') : (hosted ? T('counted on your profile') : T('ranked'))].join(' · '), body);
    if (!relabel) audio.event('ui-confirm');
  }

  function setupJourney(relabel) {
    setupRedraw = () => setupJourney(true);
    setAppState('mode-select');
    const doneSet = new Set(ui.getSave().journeyDone);
    const grid = ui.el('div', 'stage-grid');
    let firstOpen = null;
    const picked = relabel && G.config && G.config.stage ? G.config.stage.id : null;
    content.JOURNEY.forEach((st, idx) => {
      const b = ui.el('button', null, stageName(st));
      if (st.id === picked) b.classList.add('selected');
      const done = doneSet.has(st.id);
      const locked = idx > 0 && !doneSet.has(content.JOURNEY[idx - 1].id) && !done;
      b.classList.toggle('done', done);
      b.classList.toggle('locked', locked);
      b.disabled = locked;
      if (!done && !locked && !firstOpen) firstOpen = st;
      b.onclick = () => {
        grid.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        G.config = Object.assign({ modeLabel: () => T('Journey — {name}', { name: stageName(st) }), stage: st }, st);
        $('setup-rules').textContent = stageRulesText(st);
        $('btn-start-match').disabled = false;
        audio.event('ui-confirm');
      };
      grid.appendChild(b);
    });
    if (picked) {
      $('btn-start-match').disabled = false;
    } else if (firstOpen) {
      G.config = Object.assign({ modeLabel: () => T('Journey — {name}', { name: stageName(firstOpen) }) }, firstOpen);
      $('btn-start-match').disabled = false;
    } else {
      G.config = null; // journey complete: nothing to start
      $('btn-start-match').disabled = true;
    }
    ui.setupView(T('Journey'),
      T('Forty stages in four blocks: straight shots, then curve, then pressure, then mastery. Complete a stage to unlock the next.'),
      grid);
    const shown = picked ? G.config : firstOpen;
    if (shown) $('setup-rules').textContent = stageRulesText(shown);
    else $('setup-rules').textContent = T('Journey complete — every stage finished. Try the daily challenge.');
    if (!relabel) audio.event('ui-confirm');
  }

  function stageRulesText(st) {
    const c = st.constraints;
    const bans = [];
    if (c.bannedCurves.length) bans.push(T('no {list} curve', { list: c.bannedCurves.map(w).join('/') }));
    if (c.bannedHeights.length) bans.push(T('{list} shots banned', { list: c.bannedHeights.map(w).join('/') }));
    if (c.bannedColumns.length) bans.push(T('no {list} shots', { list: c.bannedColumns.map(w).join('/') }));
    return T('{n} kicks each · AI: {ai} · goal: {goal}', { n: st.rounds, ai: T(content.PRACTICE_DIFFICULTIES[st.aiDifficulty].name), goal: T(GOAL[st.goal] || st.goal) }) +
      (bans.length ? ' · ' + bans.join(', ') : '');
  }

  function setupPractice(relabel) {
    setupRedraw = () => setupPractice(true);
    setAppState('mode-select');
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', T('Unranked. Undo allowed. No effect on ratings or journey.')));
    const seg = ui.el('div', 'seg');
    const current = relabel && G.config ? G.config.aiDifficulty : 1;
    content.PRACTICE_DIFFICULTIES.forEach((d, i) => {
      const b = ui.el('button', i === current ? 'on' : null, T(d.name));
      b.title = T(d.blurb);
      b.onclick = () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        G.config.aiDifficulty = d.id;
        audio.event('ui-confirm');
      };
      seg.appendChild(b);
    });
    body.appendChild(seg);
    if (!relabel) G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: () => T('Practice'), practice: true };
    $('btn-start-match').disabled = false;
    ui.setupView(T('Practice'), T('Five kicks each · undo permitted · restart any time · unranked'), body);
    if (!relabel) audio.event('ui-confirm');
  }

  function setupChallenge(relabel) {
    setupRedraw = () => setupChallenge(true);
    setAppState('mode-select');
    const picked = relabel && G.config && G.config.challenge ? G.config.challenge.id : null;
    if (!picked) G.config = null; // require an explicit pick; never reuse a previous mode's config
    $('btn-start-match').disabled = !picked;
    const grid = ui.el('div', 'stage-grid');
    content.CHALLENGES.forEach(ch => {
      const b = ui.el('button', ch.id === picked ? 'selected' : null, T(ch.name) + ' — ' + T(ch.blurb));
      b.onclick = () => {
        grid.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        G.config = Object.assign({ modeLabel: () => T('Challenge — {name}', { name: T(ch.name) }), challenge: ch }, ch);
        $('setup-rules').textContent = stageRulesText(ch);
        $('btn-start-match').disabled = false;
        audio.event('ui-confirm');
      };
      grid.appendChild(b);
    });
    ui.setupView(T('Challenge'), T('Constrained rule sets. Pick one, then Start Match.'), grid);
    if (picked) $('setup-rules').textContent = stageRulesText(G.config);
    if (!relabel) audio.event('ui-confirm');
  }

  function setupHosted() {
    setAppState('mode-select');
    if (platform.hosted()) setupHostedRooms(); // the entry is hidden when standalone
  }

  // ---- hosted rooms (StarHermit realtime rooms, host-routed) ----

  function setupHostedRooms() {
    // No setupRedraw here: the lobby has live room state; a language change relabels the static parts.
    setupRedraw = null;
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', T('Online 1v1 shootout. Create a match and a friend can quick-join it, or jump straight into any open match.')));
    const row = ui.el('div', 'row');
    const createBtn = ui.el('button', null, T('Create online match'));
    const joinBtn = ui.el('button', null, T('Quick join a match'));
    row.append(createBtn, joinBtn);
    const status = ui.el('p', 'dim', '');
    body.append(row, status);

    const fail = (e) => T('Could not start an online match: {error} — solo modes work fine.', { error: e && e.message ? e.message : e });

    createBtn.onclick = async () => {
      createBtn.disabled = true; joinBtn.disabled = true;
      status.textContent = T('Creating…');
      try {
        const client = makeRoomsClient();
        await client.createRoom();
        wireRoomsClient(client, 'A');
        status.textContent = T('Match created — waiting for an opponent to join…');
      } catch (e) {
        createBtn.disabled = false; joinBtn.disabled = false;
        status.textContent = fail(e);
      }
    };
    joinBtn.onclick = async () => {
      createBtn.disabled = true; joinBtn.disabled = true;
      status.textContent = T('Looking for an open match…');
      try {
        const client = makeRoomsClient();
        const joined = await client.quickJoin();
        if (!joined) {
          // No open tables: host one ourselves and wait.
          await client.createRoom();
          wireRoomsClient(client, 'A');
          status.textContent = T('No open match — created one. Waiting for an opponent…');
          return;
        }
        wireRoomsClient(client, 'B');
        status.textContent = T('Joined — waiting for the host to start…');
      } catch (e) {
        createBtn.disabled = false; joinBtn.disabled = false;
        status.textContent = fail(e);
      }
    };
    ui.setupView(T('Online Match'), T('Private 1v1 shootout · host-authoritative · reconnect supported'), body);
    $('btn-start-match').disabled = true; // the match begins when an opponent joins
    audio.event('ui-confirm');
  }

  function makeRoomsClient() {
    return new rooms.RoomsClient(platform, {
      rules: rules, session: session,
      build: BUILD, contentVersion: content.CONTENT_VERSION,
      onEvent: onRoomsEvent
    });
  }

  function wireRoomsClient(client, side) {
    G.hosted = { client: client, side: side, transport: 'rooms', lastTick: -1 };
    G.mode = 'hosted';
    G.hotseat = false;
    G.humanSides = [side];
    G.match = null;
    G.lastHostedState = null;
    G.lastHostedWaiting = null;
    G.config = { modeLabel: () => T('Online Match'), rounds: 5, aiDifficulty: 1, goal: 'win', constraints: null, seed: 0 };
    ui.announce(side === 'A' ? T('Online match created. You are the host.') : T('Joined an online match.'));
  }

  function onRoomsEvent(op, msg) {
    const h = G.hosted;
    if (!h || !h.client) return;
    switch (op) {
      case 'start': beginRoomsMatch(); break;
      case 'snap': onRoomsSnap(msg); break;
      case 'cmd-rejected':
        ui.alertUser(T('Rejected: {reason}', { reason: explainReason(msg.error || 'rejected') }));
        audio.event('invalid');
        refreshRoomsHud();
        break;
      case 'result': onRoomsResult(msg); break;
      case 'peer-left': onRoomsPeerLeft(msg); break;
      case 'disconnected':
        ui.alertUser(T('Connection to the match was lost.'));
        leaveToTitle();
        break;
      case 'unavailable':
        // The room is gone (finished, closed or expired): reconnecting stopped.
        leaveToTitle();
        ui.alertUser(T('The online match is no longer available.'));
        ui.toast(T('The online match is no longer available.'));
        break;
      case 'auth-lost':
      case 'terms-required':
        // Launch token dead or updated terms need consent: reconnecting
        // stopped; offer a fresh launch through StarHermit.
        leaveToTitle();
        expiredReason = op === 'terms-required' ? 'terms' : 'expired';
        labelAccount();
        ui.alertUser(expiredReason === 'terms' ? SHT().termsTitle : SHT().expiredTitle);
        ui.openOverlay('overlay-expired');
        break;
    }
  }

  function beginRoomsMatch() {
    const h = G.hosted;
    if (!h || !h.client) return;
    if (h.client.isHost) G.match = h.client.hostMatch; // host renders via the local sim
    setAppState('active');
    ui.show('screen-play');
    audio.event('whistle-start');
    funnel('hosted-start', { side: h.side });
    refreshRoomsHud();
  }

  function refreshRoomsHud() {
    const h = G.hosted;
    if (!h || !h.client) return;
    if (G.lastHostedState) refreshHudHosted(G.lastHostedState, G.lastHostedWaiting);
    else if (h.client.isHost && G.match) refreshHud();
  }

  function onRoomsSnap(msg) {
    const h = G.hosted;
    if (!h || !h.client || !msg.state) return;
    if (h.lastTick >= 0 && msg.state.tick > h.lastTick + 1) {
      ui.announce(T('While you were away: {n} actions were played. Score {a}–{b}.', { n: msg.state.tick - h.lastTick, a: msg.state.scoreA, b: msg.state.scoreB }));
    }
    h.lastTick = msg.state.tick;
    G.lastHostedState = msg.state;
    G.lastHostedWaiting = msg.waitingFor;
    if (msg.kick) { animateRoomsKick(msg.kick); return; }
    refreshRoomsHud();
  }

  function animateRoomsKick(ev) {
    G.resolving = true;
    setAppState('resolving');
    ui.setPanels(null);
    render.playKick(ev, {
      onDone: () => {
        G.resolving = false;
        setAppState('active');
        const word = ev.outcome === 'goal' ? T('GOAL') : ev.outcome === 'saved' ? T('SAVED') : T('OFF TARGET');
        ui.announce(word + ' — ' + describeKick(ev));
        audio.event(ev.outcome === 'goal' ? 'goal' : ev.outcome === 'saved' ? 'save' : 'offtarget');
        if (ev.outcome === 'goal') haptic([20, 40, 20]);
        refreshRoomsHud();
        setTimeout(() => {
          render.resetPositions();
          if (G.lastHostedState && G.lastHostedState.over) roomsResults();
          else refreshRoomsHud();
        }, ui.getSettings().reducedMotion ? 250 : 900);
      }
    });
  }

  function roomsConfirm() {
    const h = G.hosted, st = currentState();
    if (!h || !st || !h.client) return;
    if (G.lastHostedWaiting !== h.side) { ui.alertUser(T('Waiting for opponent.')); return; }
    if (!G.sel.zone) { ui.alertUser(T('Pick a goal zone first.')); return; }
    const type = st.phase === 'keeper' ? 'dive' : 'shoot';
    const params = st.phase === 'keeper'
      ? { dir: G.sel.zone.dir, height: G.sel.zone.height, timing: G.sel.timing }
      : { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve };
    audio.event(st.phase === 'keeper' ? 'dive-committed' : 'kick');
    haptic(20);
    if (h.client.isHost) {
      const res = h.client.hostApplyCommand({ type: type, player: 'A', params: params });
      if (!res.ok) {
        ui.alertUser(T('Invalid action: {reason}', { reason: explainReason(res.reason) }));
        audio.event('invalid');
        refreshRoomsHud();
        return;
      }
      G.sel.zone = null;
    } else {
      h.client.sendCommand({
        id: 'c' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
        tick: st.tick, type: type, player: 'B', params: params
      });
      G.sel.zone = null;
      ui.setPanels('wait');
      setWait(() => T('Waiting for opponent…'));
    }
  }

  function roomsResults() {
    const h = G.hosted;
    const st = G.lastHostedState;
    if (!st) return;
    const won = st.winner === h.side;
    audio.event('whistle-end');
    audio.event(won ? 'win' : 'lose');
    const away = h.side !== 'A';
    ui.renderResults({
      headline: () => (won ? T('You win!') : T('You lose')),
      nameA: () => (away ? T('You (away)') : T('You')),
      nameB: () => T('Opponent'),
      breakdown: rules.breakdown(st),
      newAchievements: [],
      next: () => T('Authoritative result recorded by the room host.')
    });
    setAppState('results');
  }

  function onRoomsResult(msg) {
    // The host already renders from the final snapshot; a guest that missed
    // the last snap (e.g. reconnect race) still gets an honest result screen.
    if (G.lastHostedState && G.lastHostedState.over) return;
    const r = msg.result || msg;
    G.lastHostedState = null;
    const won = r.winner === (G.hosted && G.hosted.side);
    ui.renderResults({
      headline: () => (won ? T('You win!') : T('You lose')),
      nameA: () => T('Player A'), nameB: () => T('Player B'),
      breakdown: r.breakdown || null,
      newAchievements: [],
      next: () => T('Authoritative result recorded by the room host.')
    });
    setAppState('results');
  }

  function onRoomsPeerLeft(msg) {
    if (G.lastHostedState && G.lastHostedState.over) return;
    const hostLeft = msg.seat === 'A';
    ui.announce(hostLeft ? T('The host left — the match ended.') : T('Your opponent left — the match ended.'));
    ui.renderResults({
      headline: () => T('Match ended'),
      nameA: () => T('You'), nameB: () => T('Opponent'),
      breakdown: G.lastHostedState ? rules.breakdown(G.lastHostedState) : null,
      newAchievements: [],
      next: () => (hostLeft ? T('The host left the room.') : T('Your opponent left the room.'))
    });
    setAppState('results');
  }

  function randSeed() {
    const b = new Uint32Array(1);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b[0] = (Math.random() * 0xffffffff) >>> 0;
    return b[0] >>> 0;
  }

  // ---------- learn mode ----------
  function startLearn() {
    setAppState('preparing');
    G.mode = 'learn';
    G.learnStep = 0;
    G.hotseat = false;
    G.config = { seed: 0x1EAA47, rounds: 3, aiDifficulty: 0, goal: 'win', modeLabel: () => T('Learn') };
    startMatch();
  }

  function learnInstruction() {
    const step = content.TUTORIAL_STEPS[G.learnStep];
    return step ? (T(step.title) + ' — ' + T(step.body)) : null;
  }

  function advanceLearn(performed) {
    const step = content.TUTORIAL_STEPS[G.learnStep];
    if (!step) return;
    if (performed === step.require || (step.require === 'shoot-curve' && performed === 'shoot' && G.sel.curve !== 'none')) {
      G.learnStep++;
      funnel('tutorial-step', { step: G.learnStep });
      audio.event('achievement');
      if (G.learnStep >= content.TUTORIAL_STEPS.length) {
        const s = ui.getSettings();
        s.tutorialDone = true; ui.saveSettings();
        ui.announce(T('Tutorial complete. You know every rule — play a match whenever you like.'));
      } else {
        ui.announce(T('Step complete. {title}', { title: T(content.TUTORIAL_STEPS[G.learnStep].title) }));
      }
      refreshHud();
    }
  }

  // ---------- match lifecycle ----------
  function startConfiguredMatch() {
    if (!G.config) { ui.alertUser(T('Pick an option first.')); return; }
    setAppState('preparing');
    G.mode = G.config.daily ? 'daily' : G.config.stage ? 'journey' : G.config.challenge ? 'challenge' : G.config.practice ? 'practice' : 'play';
    startMatch();
  }

  function startMatch() {
    const c = G.config;
    if (G.hosted) { enterHostedPlay(); return; }
    G.match = session.createSession({
      seed: c.seed, rounds: c.rounds, constraints: c.constraints,
      build: BUILD, contentVersion: content.CONTENT_VERSION, mode: G.mode,
      ai: G.hotseat ? null : { side: 'B', difficulty: c.aiDifficulty || 0 },
      timestampOffset: 0
    });
    G.humanSides = G.hotseat ? ['A', 'B'] : ['A'];
    session.begin(G.match, platform.now());
    render.resetPositions();
    render.setView('shoot', true);
    countdown(() => {
      setAppState('active');
      ui.show('screen-play');
      audio.event('whistle-start');
      refreshHud();
      pumpTurn();
    });
  }

  function countdown(done) {
    setAppState('countdown');
    ui.show('screen-play');
    ui.setPanels('wait');
    let n = 3;
    const label = () => (G.mode === 'learn' ? T('Learn') : (ml(G.config) || T('Match')));
    const step = () => {
      if (n > 0) {
        const k = n;
        setWait(() => label() + ' — ' + k);
        ui.announce(T('{label} starting in {n}', { label: label(), n: n }));
        audio.event('tick');
        n--;
        G.countdownTimer = setTimeout(step, 700);
      } else {
        setWait(() => T('Play!'));
        G.countdownTimer = setTimeout(done, 350);
      }
    };
    step();
  }

  // Decide whose input is needed and show the right panel; AI acts when due.
  function pumpTurn() {
    if (!G.match || G.paused) return;
    const st = session.snapshot(G.match);
    if (st.over) { onMatchOver(); return; }

    // AI first (it may dive so the human can shoot immediately)
    const aiRes = session.aiAct(G.match);
    if (aiRes.length && aiRes[aiRes.length - 1].ok && G.match.state.lastResult &&
        aiRes.some(r => r.events && r.events.some(e => e.type === 'kick-resolved'))) {
      // AI shot resolved a kick against the human keeper
      const ev = lastKickEvent(aiRes);
      if (ev) { animateResolution(ev, pumpTurn); return; }
    }

    const cur = session.snapshot(G.match);
    if (cur.over) { onMatchOver(); return; }
    const need = cur.phase === 'keeper' ? rules.keeperSide(cur) : cur.shooter;
    if (G.humanSides.indexOf(need) < 0) { // AI still to act (shouldn't happen, but safe)
      setTimeout(pumpTurn, 60);
      return;
    }

    resetSelection();
    if (cur.phase === 'keeper') {
      ui.setPanels('dive');
      render.setView('keep');
      ui.announce(G.hotseat ? T('{name}: guard the goal. Pick a zone and timing.', { name: keeperName(cur) }) : T('You are keeping. Pick a zone and timing.'));
    } else {
      ui.setPanels('shoot');
      render.setView('shoot');
      ui.announce(G.hotseat ? T('{name}: take the kick. Pick a zone, curve if you like, confirm.', { name: shooterName(cur) }) : T('Your kick. Pick a zone, curve if you like, confirm.'));
    }
    armDecisionTimer();
    refreshHud();
  }

  function lastKickEvent(results) {
    for (const r of results) {
      if (r.events) {
        const ev = r.events.find(e => e.type === 'kick-resolved');
        if (ev) return ev;
      }
    }
    return null;
  }

  function keeperName(st) { return (rules.keeperSide(st) === 'A' ? T('Player A') : T('Player B')); }
  function shooterName(st) { return st.shooter === 'A' ? T('Player A') : T('Player B'); }

  function armDecisionTimer() {
    clearDecisionTimer();
    const limit = G.config && G.config.constraints && G.config.constraints.timeLimitMs;
    if (!limit) return;
    const ms = ui.getSettings().timingAssist ? limit * 2 : limit;
    G.decisionDeadline = performance.now() + ms;
    G.decisionTimer = setInterval(() => {
      if (G.paused) return;
      const left = G.decisionDeadline - performance.now();
      $('sb-clock').textContent = Math.max(0, Math.ceil(left / 1000)) + 's';
      if (left <= 0) {
        clearDecisionTimer();
        autoCommit();
      }
    }, 200);
  }
  function clearDecisionTimer() {
    if (G.decisionTimer) clearInterval(G.decisionTimer);
    G.decisionTimer = null;
    $('sb-clock').textContent = '';
  }

  function autoCommit() {
    const st = session.snapshot(G.match);
    if (st.phase === 'keeper') {
      G.sel.zone = { dir: 'center', height: 'low' }; G.sel.timing = 'on';
    } else {
      const legal = rules.legalActions(st);
      const first = legal[0];
      G.sel.zone = first ? { dir: first.params.dir, height: first.params.height } : { dir: 'center', height: 'low' };
      G.sel.curve = 'none';
    }
    ui.announce(T('Time expired — default choice committed.'));
    confirmSelection();
  }

  // ---------- selection / commit ----------
  function resetSelection() {
    G.sel = { zone: null, curve: 'none', timing: 'on' };
    markSeg('curve', 'none'); markSeg('timing', 'on');
    ui.setSelection('shoot', T('No zone selected'), false);
    ui.setSelection('dive', T('No zone selected'), false);
    render.showZoneHighlight(null);
  }

  function currentState() {
    if (G.match) return session.snapshot(G.match);
    return G.lastHostedState || null;
  }

  function onZonePick(zone) {
    if (G.appState !== 'active' || G.resolving || G.paused) return;
    const st = currentState();
    if (!st || st.over) return;
    if (G.mode === 'hosted' && (!G.hosted || G.lastHostedWaiting !== G.hosted.side)) return;
    const isKeeperPhase = st.phase === 'keeper';
    if (!isKeeperPhase) {
      // validate against constraints for immediate explanation
      const test = rules.isLegalShot(st, { dir: zone.dir, height: zone.height, curve: G.sel.curve });
      if (!test.ok) {
        ui.alertUser(T('Invalid target: {reason}', { reason: explainReason(test.reason) }));
        audio.event('invalid');
        return;
      }
    }
    G.sel.zone = zone;
    G.kbCursor = { dir: zone.dir, height: zone.height };
    render.showZoneHighlight(zone);
    audio.event('ui-confirm');
    haptic(12);
    updateSelectionUi();
  }

  function onZoneHover(zone) {
    if (G.appState !== 'active' || G.resolving) return;
    if (zone) ui.announce(T('Zone {zone}', { zone: zoneName(zone) }));
  }

  function updateSelectionUi() {
    const st = currentState();
    if (!st) return;
    const key = G.sel.zone ? G.sel.zone.dir + ':' + G.sel.zone.height : '';
    document.querySelectorAll('[data-zone]').forEach(b => {
      const on = b.dataset.zone === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (st.phase === 'keeper') {
      ui.setSelection('dive', G.sel.zone
        ? T('Dive {zone} · {timing}', { zone: zoneName(G.sel.zone), timing: w(G.sel.timing) })
        : T('No zone selected'), !!G.sel.zone);
    } else {
      let ok = !!G.sel.zone, why = '';
      if (G.sel.zone) {
        const test = rules.isLegalShot(st, { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve });
        ok = test.ok; why = test.ok ? '' : ' — ' + explainReason(test.reason);
      }
      ui.setSelection('shoot', G.sel.zone
        ? T('Shot {zone}', { zone: zoneName(G.sel.zone) }) + (G.sel.curve !== 'none' ? ' · ' + T('curve {dir}', { dir: w(G.sel.curve) }) : '') + why
        : T('No zone selected'), ok);
    }
  }

  const REASONS = {
    'column-banned': 'that column is banned in this challenge',
    'height-banned': 'that height is banned in this challenge',
    'curve-banned': 'that curve is banned in this challenge',
    'bad-direction': 'unknown direction', 'bad-height': 'unknown height',
    'bad-curve': 'unknown curve', 'bad-timing': 'unknown timing',
    'out-of-turn': 'not your turn', 'match-over': 'the match is over',
    'not-your-side': 'not your side', 'rejected': 'command rejected'
  };
  function explainReason(r) { return REASONS[r] ? T(REASONS[r]) : r; }

  function confirmSelection() {
    if (G.appState !== 'active' || G.resolving || G.paused || !G.match) return;
    const st = session.snapshot(G.match);
    if (!G.sel.zone) { ui.alertUser(T('Pick a goal zone first.')); audio.event('invalid'); return; }
    clearDecisionTimer();
    let res, performed;
    if (st.phase === 'keeper') {
      const player = rules.keeperSide(st);
      res = session.submit(G.match, 'dive', player, { dir: G.sel.zone.dir, height: G.sel.zone.height, timing: G.sel.timing });
      performed = 'dive';
    } else {
      res = session.submit(G.match, 'shoot', st.shooter, { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve });
      performed = 'shoot';
    }
    if (!res.ok) {
      ui.alertUser(T('Invalid action: {reason}', { reason: explainReason(res.reason) }));
      audio.event('invalid');
      refreshHud();
      return;
    }
    audio.event(st.phase === 'keeper' ? 'dive-committed' : 'kick');
    haptic(20);
    if (G.mode === 'learn') advanceLearn(performed);
    const kickEv = res.events ? res.events.find(e => e.type === 'kick-resolved') : null;
    if (kickEv) {
      animateResolution(kickEv, () => pumpTurn());
    } else {
      refreshHud();
      pumpTurn();
    }
  }

  // ---------- resolution animation → results flow ----------
  function animateResolution(ev, next) {
    G.resolving = true;
    setAppState('resolving');
    ui.setPanels(null);
    render.playKick(ev, {
      onDone: () => {
        G.resolving = false;
        setAppState('active');
        const word = ev.outcome === 'goal' ? T('GOAL') : ev.outcome === 'saved' ? T('SAVED') : T('OFF TARGET');
        ui.announce(word + ' — ' + describeKick(ev));
        audio.event(ev.outcome === 'goal' ? 'goal' : ev.outcome === 'saved' ? 'save' : 'offtarget');
        if (ev.outcome === 'goal') haptic([20, 40, 20]);
        refreshHud();
        setTimeout(() => {
          render.resetPositions();
          const st = session.snapshot(G.match);
          if (st.over) onMatchOver();
          else if (next) next();
        }, ui.getSettings().reducedMotion ? 250 : 900);
      }
    });
  }

  function describeKick(ev) {
    const who = ev.shooter === 'A' ? (G.hotseat ? T('Player A') : T('You')) : (G.hotseat ? T('Player B') : T('Rival'));
    return T(ev.shot.curve !== 'none' ? '{who} shot {zone} with {curve} curve; keeper went {dive} ({timing})' : '{who} shot {zone}; keeper went {dive} ({timing})', {
      who: who, zone: zoneName(ev.shot), curve: w(ev.shot.curve), dive: zoneName(ev.dive), timing: w(ev.dive.timing)
    });
  }

  function skipAnim() {
    render.skip();
    if (G.pendingAfterAnim) { const f = G.pendingAfterAnim; G.pendingAfterAnim = null; f(); }
  }

  function doUndo() {
    if (!G.match || G.mode !== 'practice') return;
    const res = session.undo(G.match);
    if (res.ok) {
      render.resetPositions();
      audio.event('ui-back');
      ui.announce(T('Undone.'));
      G.resolving = false;
      setAppState('active');
      refreshHud();
      pumpTurn();
    } else {
      ui.alertUser(T('Nothing to undo.'));
    }
  }

  function resetCamera() {
    const st = G.match ? session.snapshot(G.match) : null;
    render.setView(st && st.phase === 'keeper' ? 'keep' : 'shoot');
    audio.event('ui-confirm');
  }

  // ---------- match over / results / progression ----------
  function onMatchOver() {
    clearDecisionTimer();
    setAppState('results');
    const st = session.snapshot(G.match);
    const env = session.exportReplay(G.match);
    const verify = session.verifyReplay(G.match);
    if (!verify.ok) console.error('replay verification failed', verify);

    const humanWon = G.hotseat ? null : st.winner === 'A';
    const hot = G.hotseat;
    const headline = () => (hot
      ? (st.winner === 'A' ? T('Player A wins!') : T('Player B wins!'))
      : humanWon ? T('You win!') : T('Rival wins'));
    audio.event('whistle-end');
    audio.event(humanWon === false ? 'lose' : 'win');

    const save = ui.getSave();
    const newAch = [];
    const unlock = (key) => { const a = ui.unlockAchievement(key); if (a) { newAch.push(a); audio.event('achievement'); } };

    // stats + achievements (idempotent, local guest profile)
    save.stats.matches++;
    save.stats.goals += st.scoreA;
    save.stats.saves += st.savesA;
    save.stats.curvedGoals += st.log.filter(l => l.s === 'A' && l.o === 'goal' && l.sh[2] !== 'none').length;
    if (!G.hotseat) {
      if (st.scoreA > 0) unlock('first_goal');
      if (save.stats.curvedGoals >= 3) unlock('curve_master');
      if (save.stats.saves >= 10) unlock('keeper_10');
      if (humanWon) {
        save.stats.wins++;
        save.streak++;
        save.bestStreak = Math.max(save.bestStreak, save.streak);
        unlock('first_win');
        if (save.streak >= 3) unlock('streak_3');
      } else save.streak = 0;
    }

    let next = () => '';
    let won = humanWon;

    if (G.mode === 'journey' && G.config.stage) {
      const stg = G.config.stage;
      if (stageGoalMet(stg, st)) {
        if (save.journeyDone.indexOf(stg.id) < 0) save.journeyDone.push(stg.id);
        if (save.journeyDone.length >= 10) unlock('journey_10');
        if (save.journeyDone.length >= 40) unlock('journey_40');
        const nDone = save.journeyDone.length;
        next = nDone < content.JOURNEY.length
          ? () => T('Next recommended: Stage {n}', { n: nDone + 1 })
          : () => T('Journey complete — try the daily challenge.');
        won = true;
      } else {
        next = () => T('Goal not met ({goal}). Retry the stage.', { goal: T(GOAL[stg.goal] || stg.goal) });
        won = false;
      }
      ui.setJourneyProgress(save.journeyDone.length, content.JOURNEY.length);
    }

    if (G.mode === 'daily' && G.config.daily) {
      const day = G.config.daily.day;
      if (!save.dailyResults[day]) {
        save.dailyResults[day] = { won: !!humanWon, score: st.scoreA + '–' + st.scoreB, hash: rules.hashState(st) };
        save.stats.dailies++;
        if (save.stats.dailies >= 7) unlock('daily_7');
        showDailyBoard();
      }
      next = () => T('Next daily arrives at 00:00 UTC.');
    }

    if (G.mode === 'learn') {
      next = () => T('Tutorial done — Quick Match is one tap away on the menu.');
      won = humanWon;
    }

    ui.persistSave();
    platform.queueCloudSave(session.encodeSave(ui.getSave())); // cloud mirror; localStorage stays the cache
    ui.setProfileLine(profileLine());
    funnel('round-end', { mode: G.mode, won: !!won });

    const hash = rules.hashState(st);
    const results = {
      headline: headline,
      nameA: () => (hot ? T('Player A') : T('You')),
      nameB: () => (hot ? T('Player B') : T('Rival')),
      breakdown: env.result ? env.result.breakdown : rules.breakdown(st),
      elapsedMs: env.result ? env.result.elapsedMs : 0,
      newAchievements: newAch,
      next: next,
      extra: () => (verify.ok ? T('Replay verified: yes · final hash {hash}', { hash: hash })
        : T('Replay verified: NO — {reason} · final hash {hash}', { reason: verify.reason, hash: hash }))
    };
    postToLeaderboard(st.scoreA, results);
    setAppState('progression');
  }

  // Hosted play only: post a finished match against the AI (Quick Match,
  // Journey, Daily — not hot-seat, Learn or online) to the platform `goals`
  // board and show the player's rank on the results screen.
  function postToLeaderboard(goals, results) {
    const post = platform.hosted() && !G.hotseat && ['play', 'journey', 'daily'].indexOf(G.mode) >= 0;
    const lb = { r: null };
    // The leaderboard line is a thunk on the results so it follows a language change.
    if (post) {
      results.lb = () => {
        const L = SHT(), r = lb.r;
        return !r ? L.lbPosting : !r.posted ? L.lbFailed : r.rank ? L.lbRank.replace('{rank}', r.rank) : L.lbPosted;
      };
    }
    ui.renderResults(results);
    if (!post) return;
    const match = G.match;
    platform.submitScore(goals).then(function (r) {
      if (G.match !== match) return;
      lb.r = r;
      const line = document.getElementById('results-lb');
      if (line) line.textContent = results.lb();
    });
  }

  function stageGoalMet(stg, st) {
    if (st.winner !== 'A') return false;
    if (stg.goal === 'win-by-2') return st.scoreA - st.scoreB >= 2;
    if (stg.goal === 'clean-sheet') return st.scoreB === 0;
    return true;
  }

  // Hosted daily: read-only platform board, appended to the results screen.
  function showDailyBoard() {
    if (!platform.hosted()) return;
    platform.fetchPlatformLeaderboard({ pageSize: 10 }).then((board) => {
      if (board && board.entries && board.entries.length && ui.currentScreen() === 'screen-results') {
        ui.appendBoard('Platform board', board.entries, board.me); // English key; ui.js translates
      }
    }).catch(() => { /* offline: local record already shown */ });
  }

  function replayMatch() {
    if (G.mode === 'hosted') {
      // the hosted session is over server-side; replay as a local quick match
      G.mode = 'play';
      G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: () => T('Quick Match') };
    }
    if (G.config) { setAppState('preparing'); startMatch(); }
  }

  function nextMatch() {
    if (G.mode === 'journey') {
      const done = ui.getSave().journeyDone;
      const nextStage = content.JOURNEY.find(s => done.indexOf(s.id) < 0);
      if (nextStage) {
        G.config = Object.assign({ modeLabel: () => T('Journey — {name}', { name: stageName(nextStage) }), stage: nextStage }, nextStage);
        setAppState('preparing');
        startMatch();
        return;
      }
    }
    leaveToTitle();
  }

  function leaveToTitle() {
    setupRedraw = null;
    clearDecisionTimer();
    clearTimeout(G.countdownTimer);
    stopHostedPolling();
    G.match = null;
    G.paused = false;
    G.resolving = false;
    setAppState('title');
    render.resetPositions();
    render.setView('shoot', true);
    ui.setJourneyProgress(ui.getSave().journeyDone.length, content.JOURNEY.length);
    ui.setProfileLine(profileLine());
    ui.show('screen-title');
    audio.event('ui-back');
  }

  // ---------- pause / visibility ----------
  function pause() {
    // Only from active play: pausing mid-resolution would be stomped by the
    // animation completion handler, which forces state back to 'active'.
    if (G.appState !== 'active') return;
    G.paused = true;
    G.pausedAt = performance.now();
    setAppState('paused');
    labelPauseOverlay(true);
    ui.openOverlay('overlay-pause');
    ui.announce(T('Paused.'));
    audio.event('ui-back');
  }
  // The pause overlay doubles as the title's Settings screen: name it for what
  // it is and hide the match-only action when no match is running.
  let pauseLabelled = false;
  function labelPauseOverlay(paused) {
    const ov = document.getElementById('overlay-pause');
    pauseLabelled = paused;
    document.getElementById('pause-heading').textContent = paused ? T('Paused') : T('Settings');
    ov.querySelector('[data-action="resume"]').textContent = paused ? T('Resume') : T('Back');
    ov.querySelector('[data-action="leave"]').classList.toggle('hidden', !paused);
  }
  function resume() {
    if (!G.paused) { ui.closeOverlay('overlay-pause'); return; } // settings opened from title
    if (G.decisionTimer) G.decisionDeadline += performance.now() - G.pausedAt;
    G.paused = false;
    ui.closeOverlay('overlay-pause');
    setAppState('active');
    ui.announce(T('Resumed.'));
    audio.event('ui-confirm');

  }

  function onVisibility() {
    const hidden = document.hidden;
    audio.setBackgrounded(hidden);
    if (hidden && G.appState === 'active' && !G.hosted) pause(); // solo sim pauses
    if (hidden) audio.suspend(); else audio.resume();
  }

  // ---------- hosted play ----------
  function enterHostedPlay() {
    setAppState('active');
    ui.show('screen-play');
  }

  function stopHostedPolling() {
    if (G.hosted && G.hosted.client) G.hosted.client.leave();
    G.hosted = null;
    G.lastHostedState = null;
    G.lastHostedWaiting = null;
  }

  function refreshHudHosted(state, waitingFor) {
    G.lastHostedState = state;
    G.lastHostedWaiting = waitingFor;
    const me = G.hosted.side;
    const myTurn = waitingFor === me;
    ui.updateHud(state, {
      modeLabel: T('Online Match'),
      objective: myTurn ? (state.phase === 'keeper' ? T('Your dive') : T('Your kick')) : T('Opponent deciding…'),
      phaseText: T('Score {a}–{b}', { a: state.scoreA, b: state.scoreB }) + (state.suddenDeath ? ' · ' + T('sudden death') : '')
    });
    ui.setPanels(myTurn ? (state.phase === 'keeper' ? 'dive' : 'shoot') : 'wait');
    if (!myTurn) setWait(() => T('Waiting for opponent…'));
    render.setView(state.phase === 'keeper' ? 'keep' : 'shoot');
  }

  // ---------- HUD ----------
  function refreshHud() {
    if (!G.match) return;
    const st = session.snapshot(G.match);
    let objective = '';
    if (G.mode === 'learn') objective = learnInstruction() || T('Tutorial complete — finish the set!');
    else if (G.config && G.config.goal && G.mode !== 'play') {
      objective = T('Goal: {goal}', { goal: T(GOAL[G.config.goal] || G.config.goal) }) + ' · ' + ml(G.config);
    } else objective = ml(G.config) || T('Match');
    const phaseText = st.phase === 'keeper'
      ? (G.hotseat ? T('{name} keeping', { name: keeperName(st) }) : (rules.keeperSide(st) === 'A' ? T('Your dive') : T('Rival guards')))
      : (G.hotseat ? T('{name} shooting', { name: shooterName(st) }) : (st.shooter === 'A' ? T('Your kick') : T('Rival shoots')));
    ui.updateHud(st, {
      modeLabel: ml(G.config) || 'Spot Kick',
      objective: objective,
      phaseText: phaseText + ' · ' + T('kick {n} of {total}', { n: Math.min(st.kicksA + st.kicksB + 1, st.rounds * 2), total: st.rounds * 2 }) +
        (st.suddenDeath ? ' · ' + T('SUDDEN DEATH') : '')
    });
    $('btn-undo').classList.toggle('hidden', G.mode !== 'practice' || G.match.undoStack.length === 0);
    audio.setTension(st.suddenDeath);
    updateSelectionUi();
  }

  // Wait-panel text as a thunk, so the countdown and "waiting" lines follow a language change.
  let waitText = null;
  function setWait(fn) { waitText = fn; ui.setWaitText(fn()); }

  /**
   * Language change (Settings → Language): static markup is re-applied by
   * i18n.js; redraw everything built in code from current state — no restart,
   * no new deal of kicks, no reconnect.
   */
  function relocalize() {
    labelAccount();
    fillThemeSelect();
    ui.renderHelp(keyboardBindings());
    if (window.SpotKickGfxPanel.setLang) window.SpotKickGfxPanel.setLang(gameLang());
    ui.setProfileLine(profileLine());
    if (!document.getElementById('overlay-pause').classList.contains('hidden')) labelPauseOverlay(pauseLabelled);
    if (G.appState === 'mode-select' && setupRedraw && ui.currentScreen() === 'screen-setup') setupRedraw();
    if (G.hosted && G.lastHostedState) refreshRoomsHud();
    else if (G.match) refreshHud();
    if (waitText && !document.getElementById('panel-wait').classList.contains('hidden')) ui.setWaitText(waitText());
    ui.relabelResults();
  }

  // ---------- misc ----------
  function haptic(pattern) {
    if (ui.getSettings().hapticsOff) return;
    if (navigator.vibrate) try { navigator.vibrate(pattern); } catch (_) {}
  }

  // Anonymous aggregate funnel only: start, tutorial step, round end, retry,
  // settings change, error category. No text, no identifiers.
  const funnelQueue = [];
  function funnel(kind, data) {
    funnelQueue.push({ kind: kind, at: Date.now(), data: data || {} });
    if (funnelQueue.length > 50) funnelQueue.shift();
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    render.resize(w, h, window.devicePixelRatio || 1);
    syncSafeInsets();
    if (window.SpotKickGfxPanel) window.SpotKickGfxPanel.refreshSummary();
  }

  // Tell the renderer which bands of the canvas the HUD covers (status text at
  // the top, control tray at the bottom) so the goal is framed between them.
  function syncSafeInsets() {
    if (!render.setSafeInsets) return;
    const H = window.innerHeight, W = window.innerWidth;
    const top = document.getElementById('hud-top');
    const controls = document.getElementById('hud-controls');
    const ins = { top: 0, bottom: 0, left: 0, right: 0 };
    if (top && top.offsetParent !== null) ins.top = Math.min(H * 0.3, Math.max(0, top.getBoundingClientRect().bottom));
    if (controls && controls.offsetParent !== null) {
      const r = controls.getBoundingClientRect();
      const landscape = W > H && H <= 500;
      if (landscape) {
        // side-by-side tray: only the columns it occupies are covered
        const panel = controls.querySelector('#panel-shoot:not(.hidden), #panel-dive:not(.hidden), #panel-wait:not(.hidden)');
        const actions = document.getElementById('hud-actions');
        if (panel) ins.left = Math.min(W * 0.45, panel.getBoundingClientRect().right);
        if (actions) ins.right = Math.min(W * 0.3, W - actions.getBoundingClientRect().left);
      } else {
        const visible = [...controls.children].filter(c => !c.classList.contains('hidden'));
        const topMost = visible.length ? Math.min(...visible.map(c => c.getBoundingClientRect().top)) : r.bottom;
        ins.bottom = Math.min(H * 0.55, Math.max(0, H - topMost));
      }
    }
    render.setSafeInsets(ins);
    // keep captions clear of the tray (bottom is in the zoomed layer's px)
    const zoom = (window.UIScale && window.UIScale.value) || 1;
    document.documentElement.style.setProperty('--caption-lift', (ins.bottom ? ins.bottom / zoom : 0) + 'px');
  }
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => syncSafeInsets());
    ['hud-top', 'hud-controls', 'panel-shoot', 'panel-dive', 'panel-wait'].forEach(id => { const el = document.getElementById(id); if (el) ro.observe(el); });
  }
  const hudMo = new MutationObserver(() => syncSafeInsets());
  ['panel-shoot', 'panel-dive', 'panel-wait'].forEach(id => { const el = document.getElementById(id); if (el) hudMo.observe(el, { attributes: true, attributeFilter: ['class'] }); });

  // ---------- main loop ----------
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return; // zero rendering while hidden
    if (now - lastFrame < 15) return; // ~60fps cap; simulation is event-driven
    lastFrame = now;
    pollGamepad();
    render.renderFrame(performance.now()); // single clock for all animation timing
  }

  // Hosted commit replaces local confirm when in hosted mode
  const origConfirm = confirmSelection;
  confirmSelection = function () {
    if (G.mode === 'hosted' && G.hosted && G.hosted.transport === 'rooms') { roomsConfirm(); return; }
    origConfirm();
  };

  // boot when DOM ready
  window.SpotKickDebug = { G: G, rules: rules, session: session };
  document.addEventListener('sk-language', relocalize);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
