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
    ui.setLoadingStatus('Checking content…');
    const check = content.validateContent();
    if (!check.ok) console.error('Content validation failed:', check.errors);

    ui.loadSettings();
    ui.loadSave();
    fillThemeSelect();
    ui.renderHelp(keyboardBindings());

    const canvas = $('game-canvas');
    const ok = render.init(canvas, { onPick: onZonePick, onHover: onZoneHover });
    if (!ok) { ui.showCompat(); return; }
    applyVisualSettings();
    render.setTheme(currentTheme());

    wireUi();
    wireInput();
    ui.bindSettings(onSettingChange);
    platform.syncTime(); // best effort; game works offline regardless

    // Hosted boot: resolve the account nickname, then adopt the cloud save
    // (remote wins) before the profile line and journey counts render.
    platform.onSync(() => { if (G.appState === 'title') ui.setProfileLine(profileLine()); });
    if (platform.hosted()) {
      ui.setLoadingStatus('Connecting to your account…');
      platform.initHosted().then((remote) => {
        if (remote) {
          try {
            const parsed = session.decodeSave(remote);
            if (parsed && parsed.data) ui.adoptSave(parsed.data);
          } catch (_) { /* malformed remote doc: local cache stays */ }
        }
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

  function setAppState(s, reason) {
    G.appState = s;
    document.body.dataset.state = s;
    if (reason) console.info('[state]', s, '—', reason);
  }

  function profileLine() {
    const s = ui.getSave();
    const wins = s.stats.wins, m = s.stats.matches;
    const stats = m ? (wins + ' wins in ' + m + ' matches · best streak ' + s.bestStreak) : null;
    if (platform.hosted()) {
      const sync = { saving: 'saving…', synced: 'synced', offline: 'offline' }[platform.getSyncStatus()] || 'offline';
      return 'Playing as ' + (platform.displayName() || '…') + ' · cloud save ' + sync + (stats ? ' · ' + stats : '');
    }
    return m ? ('Guest profile · ' + stats) : 'Guest profile — progress is stored on this device';
  }

  function currentTheme() {
    const s = ui.getSettings();
    if (s.highContrast) return content.THEMES.find(t => t.id === 'mono');
    return content.THEMES.find(t => t.id === s.theme) || content.THEMES[0];
  }

  function fillThemeSelect() {
    const sel = $('opt-theme');
    sel.innerHTML = '';
    content.THEMES.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      sel.appendChild(o);
    });
  }

  function applyVisualSettings() {
    const s = ui.getSettings();
    render.setQuality(s.quality);
    render.setReducedMotion(s.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    audio.setLevel('music', s.music / 100);
    audio.setLevel('sfx', s.sfx / 100);
    audio.setLevel('ambience', s.ambience / 100);
    audio.setLevel('voice', s.voice / 100);
  }

  function onSettingChange(key, value) {
    if (key === 'quality') render.setQuality(value);
    if (key === 'theme') { render.setTheme(currentTheme()); }
    if (key === 'highContrast') render.setTheme(currentTheme());
    if (key === 'reducedMotion') applyVisualSettings();
    if (['music', 'sfx', 'ambience', 'voice'].indexOf(key) >= 0) audio.setLevel(key, value / 100);
    audio.event('ui-confirm');
    funnel('settings-change', { key: key });
  }

  // ---------- input wiring ----------
  function wireUi() {
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      audio.unlock();
      handleAction(btn.dataset.action, btn);
    });
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
    audio.onCaption((t) => ui.caption(t));
  }

  function markSeg(kind, val) {
    document.querySelectorAll('[data-' + kind + ']').forEach(b => {
      const on = b.dataset[kind] === val;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function keyboardBindings() {
    return [
      'Arrow keys: move zone cursor', 'Enter/Space: select zone or confirm',
      'Q/E: curve', '1/2/3: dive timing', 'Esc: pause', 'U: undo (practice)',
      'H: help', 'C: reset camera', 'S: skip animation'
    ];
  }

  function wireInput() {
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const playing = G.appState === 'active' && !ui.anyOverlayOpen();
    if (e.key === 'Escape') {
      if (ui.anyOverlayOpen()) { ui.closeOverlay('overlay-help'); ui.closeOverlay('overlay-pause'); if (G.appState === 'paused') resume(); }
      else if (playing) pause();
      return;
    }
    if (e.key === 'h' || e.key === 'H') { ui.renderHelp(keyboardBindings()); ui.openOverlay('overlay-help'); return; }
    if (!playing) return;
    const cols = rules.COLUMNS;
    let i = cols.indexOf(G.kbCursor.dir);
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight') i = Math.min(cols.length - 1, i + 1);
    else if (e.key === 'ArrowUp') G.kbCursor.height = 'high';
    else if (e.key === 'ArrowDown') G.kbCursor.height = 'low';
    else if (e.key === 'q' || e.key === 'Q') cycleCurve(-1);
    else if (e.key === 'e' || e.key === 'E') cycleCurve(1);
    else if (e.key === '1') setTiming('early');
    else if (e.key === '2') setTiming('on');
    else if (e.key === '3') setTiming('late');
    else if (e.key === 'u' || e.key === 'U') { doUndo(); return; }
    else if (e.key === 'c' || e.key === 'C') { resetCamera(); return; }
    else if (e.key === 's' || e.key === 'S') { skipAnim(); return; }
    else if (e.key === 'Enter' || e.key === ' ') {
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
      case 'settings': ui.openOverlay('overlay-pause'); break;
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
  function setupPlay() {
    setAppState('mode-select');
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', 'A five-kick shootout. You shoot first, then guard the goal.'));
    const vs = ui.el('div', 'seg');
    const aiBtn = ui.el('button', 'on', 'Vs AI (Club)');
    const p2Btn = ui.el('button', null, 'Two players · this device');
    aiBtn.onclick = () => { G.hotseat = false; aiBtn.classList.add('on'); p2Btn.classList.remove('on'); };
    p2Btn.onclick = () => { G.hotseat = true; p2Btn.classList.add('on'); aiBtn.classList.remove('on'); };
    vs.append(aiBtn, p2Btn);
    body.appendChild(vs);
    G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: 'Quick Match' };
    $('btn-start-match').disabled = false;
    ui.setupView('Quick Match', 'Five kicks each · sudden death on ties · about 3 minutes · unranked', body);
    audio.event('ui-confirm');
  }

  function setupDaily() {
    setAppState('mode-select');
    const day = content.utcDay(new Date(platform.now()));
    const d = content.dailyFor(day);
    const done = ui.getSave().dailyResults[day];
    const hosted = platform.hosted();
    const body = ui.el('div');
    body.appendChild(ui.el('p', null, 'Seed: ' + d.seed.toString(16) + ' · ' + day + ' (UTC)'));
    body.appendChild(ui.el('p', 'dim', done
      ? 'Played today: ' + (done.won ? 'won ' + done.score : 'lost ' + done.score) + '. You can replay, but the recorded result stands.'
      : (hosted
        ? 'One shared seed for everyone today. Your first result is recorded to your profile.'
        : 'One shared seed for everyone today. First result is ranked.')));
    G.config = Object.assign({ modeLabel: 'Daily Challenge', daily: d, ranked: !done }, d);
    $('btn-start-match').disabled = false;
    ui.setupView('Daily Challenge', 'Five kicks · Club keeper · ' +
      (hosted ? 'first result recorded per UTC day' : 'ranked once per UTC day') + ' · ' +
      (d.excluded ? 'excluded from the board' : (hosted ? 'counted on your profile' : 'ranked')), body);
    audio.event('ui-confirm');
  }

  function setupJourney() {
    setAppState('mode-select');
    const doneSet = new Set(ui.getSave().journeyDone);
    const grid = ui.el('div', 'stage-grid');
    let firstOpen = null;
    content.JOURNEY.forEach((st, idx) => {
      const b = ui.el('button', null, st.name);
      const done = doneSet.has(st.id);
      const locked = idx > 0 && !doneSet.has(content.JOURNEY[idx - 1].id) && !done;
      b.classList.toggle('done', done);
      b.classList.toggle('locked', locked);
      b.disabled = locked;
      if (!done && !locked && !firstOpen) firstOpen = st;
      b.onclick = () => {
        grid.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        G.config = Object.assign({ modeLabel: 'Journey — ' + st.name, stage: st }, st);
        $('setup-rules').textContent = stageRulesText(st);
        $('btn-start-match').disabled = false;
        audio.event('ui-confirm');
      };
      grid.appendChild(b);
    });
    if (firstOpen) {
      G.config = Object.assign({ modeLabel: 'Journey — ' + firstOpen.name }, firstOpen);
      $('btn-start-match').disabled = false;
    } else {
      G.config = null; // journey complete: nothing to start
      $('btn-start-match').disabled = true;
    }
    ui.setupView('Journey',
      'Forty stages in four blocks: straight shots, then curve, then pressure, then mastery. Complete a stage to unlock the next.',
      grid);
    if (firstOpen) $('setup-rules').textContent = stageRulesText(firstOpen);
    else $('setup-rules').textContent = 'Journey complete — every stage finished. Try the daily challenge.';
    audio.event('ui-confirm');
  }

  function stageRulesText(st) {
    const c = st.constraints;
    const bans = [];
    if (c.bannedCurves.length) bans.push('no ' + c.bannedCurves.join('/') + ' curve');
    if (c.bannedHeights.length) bans.push(c.bannedHeights.join('/') + ' shots banned');
    if (c.bannedColumns.length) bans.push('no ' + c.bannedColumns.join('/') + ' shots');
    return st.rounds + ' kicks each · AI: ' + content.PRACTICE_DIFFICULTIES[st.aiDifficulty].name +
      ' · goal: ' + st.goal + (bans.length ? ' · ' + bans.join(', ') : '');
  }

  function setupPractice() {
    setAppState('mode-select');
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', 'Unranked. Undo allowed. No effect on ratings or journey.'));
    const seg = ui.el('div', 'seg');
    content.PRACTICE_DIFFICULTIES.forEach((d, i) => {
      const b = ui.el('button', i === 1 ? 'on' : null, d.name);
      b.title = d.blurb;
      b.onclick = () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        G.config.aiDifficulty = d.id;
        audio.event('ui-confirm');
      };
      seg.appendChild(b);
    });
    body.appendChild(seg);
    G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: 'Practice', practice: true };
    $('btn-start-match').disabled = false;
    ui.setupView('Practice', 'Five kicks each · undo permitted · restart any time · unranked', body);
    audio.event('ui-confirm');
  }

  function setupChallenge() {
    setAppState('mode-select');
    G.config = null; // require an explicit pick; never reuse a previous mode's config
    $('btn-start-match').disabled = true;
    const grid = ui.el('div', 'stage-grid');
    content.CHALLENGES.forEach(ch => {
      const b = ui.el('button', null, ch.name + ' — ' + ch.blurb);
      b.onclick = () => {
        grid.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        G.config = Object.assign({ modeLabel: 'Challenge — ' + ch.name, challenge: ch }, ch);
        $('setup-rules').textContent = stageRulesText(ch);
        $('btn-start-match').disabled = false;
        audio.event('ui-confirm');
      };
      grid.appendChild(b);
    });
    ui.setupView('Challenge', 'Constrained rule sets. Pick one, then Start Match.', grid);
    audio.event('ui-confirm');
  }

  function setupHosted() {
    setAppState('mode-select');
    if (platform.hosted()) { setupHostedRooms(); return; }
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', 'Authoritative dev-server match. Share the code for a private invite. (On StarHermit, hosted play uses Online Match rooms.)'));
    const rowCreate = ui.el('div', 'row');
    const createBtn = ui.el('button', null, 'Create private match');
    const joinInput = document.createElement('input');
    joinInput.placeholder = 'Invite code'; joinInput.setAttribute('aria-label', 'Invite code');
    joinInput.maxLength = 8;
    joinInput.style.cssText = 'font:inherit;padding:10px;border-radius:8px;border:1px solid #2a3a55;background:#1a2942;color:#fff;text-transform:uppercase';
    const joinBtn = ui.el('button', null, 'Join');
    rowCreate.append(createBtn, joinInput, joinBtn);
    const status = ui.el('p', 'dim', '');
    body.append(rowCreate, status);

    createBtn.onclick = async () => {
      createBtn.disabled = true;
      status.textContent = 'Creating…';
      const res = await platform.createHosted({ build: BUILD, contentVersion: content.CONTENT_VERSION });
      createBtn.disabled = false;
      if (!res.ok) { status.textContent = 'Could not create match: ' + res.error + ' (server unreachable — solo modes work offline)'; return; }
      beginHosted(res.data.code, res.data.token, 'A', status);
    };
    joinBtn.onclick = async () => {
      const code = joinInput.value.trim().toUpperCase();
      if (!code) { status.textContent = 'Enter an invite code.'; return; }
      const res = await platform.joinHosted(code);
      if (!res.ok) { status.textContent = 'Could not join: ' + res.error; return; }
      beginHosted(res.data.code, res.data.token, 'B', status);
    };
    ui.setupView('Hosted Play', 'Private invitation matches · reconnect supported · server-authoritative results', body);
    $('btn-start-match').disabled = true; // hosted matches begin via Create/Join above
    audio.event('ui-confirm');
  }

  // ---- hosted rooms (StarHermit realtime rooms, host-routed) ----

  function setupHostedRooms() {
    const body = ui.el('div');
    body.appendChild(ui.el('p', 'dim', 'Online 1v1 shootout. Create a match and a friend can quick-join it, or jump straight into any open match.'));
    const row = ui.el('div', 'row');
    const createBtn = ui.el('button', null, 'Create online match');
    const joinBtn = ui.el('button', null, 'Quick join a match');
    row.append(createBtn, joinBtn);
    const status = ui.el('p', 'dim', '');
    body.append(row, status);

    const fail = (e) => 'Could not start an online match: ' + (e && e.message ? e.message : e) + ' — solo modes work fine.';

    createBtn.onclick = async () => {
      createBtn.disabled = true; joinBtn.disabled = true;
      status.textContent = 'Creating…';
      try {
        const client = makeRoomsClient();
        await client.createRoom();
        wireRoomsClient(client, 'A');
        status.textContent = 'Match created — waiting for an opponent to join…';
      } catch (e) {
        createBtn.disabled = false; joinBtn.disabled = false;
        status.textContent = fail(e);
      }
    };
    joinBtn.onclick = async () => {
      createBtn.disabled = true; joinBtn.disabled = true;
      status.textContent = 'Looking for an open match…';
      try {
        const client = makeRoomsClient();
        const joined = await client.quickJoin();
        if (!joined) {
          // No open tables: host one ourselves and wait.
          await client.createRoom();
          wireRoomsClient(client, 'A');
          status.textContent = 'No open match — created one. Waiting for an opponent…';
          return;
        }
        wireRoomsClient(client, 'B');
        status.textContent = 'Joined — waiting for the host to start…';
      } catch (e) {
        createBtn.disabled = false; joinBtn.disabled = false;
        status.textContent = fail(e);
      }
    };
    ui.setupView('Online Match', 'Private 1v1 shootout · host-authoritative · reconnect supported', body);
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
    G.config = { modeLabel: 'Online Match', rounds: 5, aiDifficulty: 1, goal: 'win', constraints: null, seed: 0 };
    ui.announce(side === 'A' ? 'Online match created. You are the host.' : 'Joined an online match.');
  }

  function onRoomsEvent(op, msg) {
    const h = G.hosted;
    if (!h || !h.client) return;
    switch (op) {
      case 'start': beginRoomsMatch(); break;
      case 'snap': onRoomsSnap(msg); break;
      case 'cmd-rejected':
        ui.alertUser('Rejected: ' + (msg.error || 'command'));
        audio.event('invalid');
        refreshRoomsHud();
        break;
      case 'result': onRoomsResult(msg); break;
      case 'peer-left': onRoomsPeerLeft(msg); break;
      case 'disconnected':
        ui.alertUser('Connection to the match was lost.');
        leaveToTitle();
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
      ui.announce('While you were away: ' + (msg.state.tick - h.lastTick) + ' actions were played. Score ' +
        msg.state.scoreA + '–' + msg.state.scoreB + '.');
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
        const word = ev.outcome === 'goal' ? 'GOAL' : ev.outcome === 'saved' ? 'SAVED' : 'OFF TARGET';
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
    if (G.lastHostedWaiting !== h.side) { ui.alertUser('Waiting for opponent.'); return; }
    if (!G.sel.zone) { ui.alertUser('Pick a goal zone first.'); return; }
    const type = st.phase === 'keeper' ? 'dive' : 'shoot';
    const params = st.phase === 'keeper'
      ? { dir: G.sel.zone.dir, height: G.sel.zone.height, timing: G.sel.timing }
      : { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve };
    audio.event(st.phase === 'keeper' ? 'dive-committed' : 'kick');
    haptic(20);
    if (h.client.isHost) {
      const res = h.client.hostApplyCommand({ type: type, player: 'A', params: params });
      if (!res.ok) {
        ui.alertUser('Invalid action: ' + explainReason(res.reason));
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
      ui.setWaitText('Waiting for opponent…');
    }
  }

  function roomsResults() {
    const h = G.hosted;
    const st = G.lastHostedState;
    if (!st) return;
    const won = st.winner === h.side;
    audio.event('whistle-end');
    audio.event(won ? 'win' : 'lose');
    ui.renderResults({
      headline: won ? 'You win!' : 'You lose',
      nameA: 'You' + (h.side === 'A' ? '' : ' (away)'),
      nameB: 'Opponent',
      breakdown: rules.breakdown(st),
      newAchievements: [],
      next: 'Authoritative result recorded by the room host.'
    });
    setAppState('results');
  }

  function onRoomsResult(msg) {
    // The host already renders from the final snapshot; a guest that missed
    // the last snap (e.g. reconnect race) still gets an honest result screen.
    if (G.lastHostedState && G.lastHostedState.over) return;
    const r = msg.result || msg;
    G.lastHostedState = null;
    ui.renderResults({
      headline: (r.winner === (G.hosted && G.hosted.side)) ? 'You win!' : 'You lose',
      nameA: 'Player A', nameB: 'Player B',
      breakdown: r.breakdown || null,
      newAchievements: [],
      next: 'Authoritative result recorded by the room host.'
    });
    setAppState('results');
  }

  function onRoomsPeerLeft(msg) {
    if (G.lastHostedState && G.lastHostedState.over) return;
    ui.announce(msg.seat === 'A' ? 'The host left — the match ended.' : 'Your opponent left — the match ended.');
    ui.renderResults({
      headline: 'Match ended',
      nameA: 'You', nameB: 'Opponent',
      breakdown: G.lastHostedState ? rules.breakdown(G.lastHostedState) : null,
      newAchievements: [],
      next: msg.seat === 'A' ? 'The host left the room.' : 'Your opponent left the room.'
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
    G.config = { seed: 0x1EAA47, rounds: 3, aiDifficulty: 0, goal: 'win', modeLabel: 'Learn' };
    startMatch();
  }

  function learnInstruction() {
    const step = content.TUTORIAL_STEPS[G.learnStep];
    return step ? (step.title + ' — ' + step.body) : null;
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
        ui.announce('Tutorial complete. You know every rule — play a match whenever you like.');
      } else {
        ui.announce('Step complete. ' + content.TUTORIAL_STEPS[G.learnStep].title);
      }
      refreshHud();
    }
  }

  // ---------- match lifecycle ----------
  function startConfiguredMatch() {
    if (!G.config) { ui.alertUser('Pick an option first.'); return; }
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
    const label = G.mode === 'learn' ? 'Learn' : (G.config.modeLabel || 'Match');
    const step = () => {
      if (n > 0) {
        ui.setWaitText(label + ' — ' + n);
        ui.announce(label + ' starting in ' + n);
        audio.event('tick');
        n--;
        G.countdownTimer = setTimeout(step, 700);
      } else {
        ui.setWaitText('Play!');
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
      ui.announce((G.hotseat ? keeperName(cur) + ': guard the goal' : 'You are keeping') + '. Pick a zone and timing.');
    } else {
      ui.setPanels('shoot');
      render.setView('shoot');
      ui.announce((G.hotseat ? shooterName(cur) + ': take the kick' : 'Your kick') + '. Pick a zone, curve if you like, confirm.');
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

  function keeperName(st) { return (rules.keeperSide(st) === 'A' ? 'Player A' : 'Player B'); }
  function shooterName(st) { return st.shooter === 'A' ? 'Player A' : 'Player B'; }

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
    ui.announce('Time expired — default choice committed.');
    confirmSelection();
  }

  // ---------- selection / commit ----------
  function resetSelection() {
    G.sel = { zone: null, curve: 'none', timing: 'on' };
    markSeg('curve', 'none'); markSeg('timing', 'on');
    ui.setSelection('shoot', 'No zone selected', false);
    ui.setSelection('dive', 'No zone selected', false);
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
        ui.alertUser('Invalid target: ' + explainReason(test.reason));
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
    if (zone) ui.announce('Zone ' + zone.dir + ' ' + zone.height);
  }

  function updateSelectionUi() {
    const st = currentState();
    if (!st) return;
    if (st.phase === 'keeper') {
      ui.setSelection('dive', G.sel.zone
        ? 'Dive ' + G.sel.zone.dir + ' ' + G.sel.zone.height + ' · ' + G.sel.timing
        : 'No zone selected', !!G.sel.zone);
    } else {
      let ok = !!G.sel.zone, why = '';
      if (G.sel.zone) {
        const test = rules.isLegalShot(st, { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve });
        ok = test.ok; why = test.ok ? '' : ' — ' + explainReason(test.reason);
      }
      ui.setSelection('shoot', G.sel.zone
        ? 'Shot ' + G.sel.zone.dir + ' ' + G.sel.zone.height + (G.sel.curve !== 'none' ? ' · curve ' + G.sel.curve : '') + why
        : 'No zone selected', ok);
    }
  }

  function explainReason(r) {
    return {
      'column-banned': 'that column is banned in this challenge',
      'height-banned': 'that height is banned in this challenge',
      'curve-banned': 'that curve is banned in this challenge',
      'bad-direction': 'unknown direction', 'bad-height': 'unknown height',
      'bad-curve': 'unknown curve', 'bad-timing': 'unknown timing',
      'out-of-turn': 'not your turn', 'match-over': 'the match is over'
    }[r] || r;
  }

  function confirmSelection() {
    if (G.appState !== 'active' || G.resolving || G.paused || !G.match) return;
    const st = session.snapshot(G.match);
    if (!G.sel.zone) { ui.alertUser('Pick a goal zone first.'); audio.event('invalid'); return; }
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
      ui.alertUser('Invalid action: ' + explainReason(res.reason));
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
        const word = ev.outcome === 'goal' ? 'GOAL' : ev.outcome === 'saved' ? 'SAVED' : 'OFF TARGET';
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
    const who = ev.shooter === 'A' ? (G.hotseat ? 'Player A' : 'You') : (G.hotseat ? 'Player B' : 'Rival');
    return who + ' shot ' + ev.shot.dir + ' ' + ev.shot.height +
      (ev.shot.curve !== 'none' ? ' with ' + ev.shot.curve + ' curve' : '') +
      '; keeper went ' + ev.dive.dir + ' ' + ev.dive.height + ' (' + ev.dive.timing + ')';
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
      ui.announce('Undone.');
      G.resolving = false;
      setAppState('active');
      refreshHud();
      pumpTurn();
    } else {
      ui.alertUser('Nothing to undo.');
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
    const headline = G.hotseat
      ? (st.winner === 'A' ? 'Player A wins!' : 'Player B wins!')
      : humanWon ? 'You win!' : 'Rival wins';
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

    let next = '';
    let won = humanWon;

    if (G.mode === 'journey' && G.config.stage) {
      const stg = G.config.stage;
      if (stageGoalMet(stg, st)) {
        if (save.journeyDone.indexOf(stg.id) < 0) save.journeyDone.push(stg.id);
        if (save.journeyDone.length >= 10) unlock('journey_10');
        if (save.journeyDone.length >= 40) unlock('journey_40');
        next = save.journeyDone.length < content.JOURNEY.length
          ? 'Next recommended: Stage ' + (save.journeyDone.length + 1)
          : 'Journey complete — try the daily challenge.';
        won = true;
      } else {
        next = 'Goal not met (' + stg.goal.replace('-', ' ') + '). Retry the stage.';
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
        submitDailyScore(env, st);
        showDailyBoard();
      }
      next = 'Next daily arrives at 00:00 UTC.';
    }

    if (G.mode === 'learn') {
      next = 'Tutorial done — Quick Match is one tap away on the menu.';
      won = humanWon;
    }

    ui.persistSave();
    platform.queueCloudSave(session.encodeSave(ui.getSave())); // cloud mirror; localStorage stays the cache
    ui.setProfileLine(profileLine());
    funnel('round-end', { mode: G.mode, won: !!won });

    ui.renderResults({
      headline: headline,
      nameA: G.hotseat ? 'Player A' : 'You',
      nameB: G.hotseat ? 'Player B' : 'Rival',
      breakdown: env.result ? env.result.breakdown : rules.breakdown(st),
      elapsedMs: env.result ? env.result.elapsedMs : 0,
      newAchievements: newAch,
      next: next,
      extra: 'Replay verified: ' + (verify.ok ? 'yes' : 'NO — ' + verify.reason) +
        ' · final hash ' + rules.hashState(st)
    });
    setAppState('progression');
  }

  function stageGoalMet(stg, st) {
    if (st.winner !== 'A') return false;
    if (stg.goal === 'win-by-2') return st.scoreA - st.scoreB >= 2;
    if (stg.goal === 'clean-sheet') return st.scoreB === 0;
    return true;
  }

  async function submitDailyScore(env, st) {
    if (platform.hosted()) return; // platform boards are read-only; the record stays local + cloud
    const entry = {
      board: 'daily-' + G.config.daily.day,
      name: platform.displayName() || 'Guest',
      ruleset: rules.VERSION,
      contentVersion: content.CONTENT_VERSION,
      seed: env.seed,
      assists: ui.getSettings().timingAssist ? ['timing-assist'] : [],
      durationMs: env.result ? env.result.elapsedMs : 0,
      score: st.scoreA, conceded: st.scoreB,
      replay: env
    };
    const res = await platform.submitScore(entry);
    if (!res.ok) console.info('leaderboard submit skipped:', res.error);
  }

  // Hosted daily: read-only platform board, appended to the results screen.
  function showDailyBoard() {
    if (!platform.hosted()) return;
    platform.fetchPlatformLeaderboard({ pageSize: 10 }).then((board) => {
      if (board && board.entries && board.entries.length && ui.currentScreen() === 'screen-results') {
        ui.appendBoard('Platform board', board.entries, board.me);
      }
    }).catch(() => { /* offline: local record already shown */ });
  }

  function replayMatch() {
    if (G.mode === 'hosted') {
      // the hosted session is over server-side; replay as a local quick match
      G.mode = 'play';
      G.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: 'win', modeLabel: 'Quick Match' };
    }
    if (G.config) { setAppState('preparing'); startMatch(); }
  }

  function nextMatch() {
    if (G.mode === 'journey') {
      const done = ui.getSave().journeyDone;
      const nextStage = content.JOURNEY.find(s => done.indexOf(s.id) < 0);
      if (nextStage) {
        G.config = Object.assign({ modeLabel: 'Journey — ' + nextStage.name, stage: nextStage }, nextStage);
        setAppState('preparing');
        startMatch();
        return;
      }
    }
    leaveToTitle();
  }

  function leaveToTitle() {
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
    ui.openOverlay('overlay-pause');
    ui.announce('Paused.');
    audio.event('ui-back');
  }
  function resume() {
    if (!G.paused) { ui.closeOverlay('overlay-pause'); return; } // settings opened from title
    if (G.decisionTimer) G.decisionDeadline += performance.now() - G.pausedAt;
    G.paused = false;
    ui.closeOverlay('overlay-pause');
    setAppState('active');
    ui.announce('Resumed.');
    audio.event('ui-confirm');
    if (G.hosted) pollHostedSoon();

  }

  function onVisibility() {
    const hidden = document.hidden;
    audio.setBackgrounded(hidden);
    if (hidden && G.appState === 'active' && !G.hosted) pause(); // solo sim pauses
    if (hidden) audio.suspend(); else audio.resume();
  }

  // ---------- hosted play ----------
  function beginHosted(code, token, side, statusEl) {
    G.hosted = { code: code, token: token, side: side, lastTick: -1 };
    G.mode = 'hosted';
    G.hotseat = false;
    G.humanSides = [side];
    G.config = { modeLabel: 'Hosted ' + code, rounds: 5, aiDifficulty: 1, goal: 'win', constraints: null, seed: 0 };
    if (statusEl) statusEl.textContent = 'Match ' + code + ' — you are Player ' + side + '. Share the code with a friend.';
    ui.announce('Hosted match ' + code + '. You are player ' + side + '.');
    enterHostedPlay();
  }

  function enterHostedPlay() {
    setAppState('active');
    ui.show('screen-play');
    pollHosted();
  }

  async function pollHosted() {
    if (!G.hosted) return;
    if (G.hosted.transport === 'rooms') return; // rooms use the realtime socket, not polling
    const h = G.hosted;
    const res = await platform.sessionSnapshot(h.code, h.token);
    if (G.hosted !== h) return; // left the match while the request was in flight
    if (!res.ok) {
      ui.setPanels('wait');
      ui.setWaitText('Connection issue (' + res.error + ') — retrying…');
      h.pollTimer = setTimeout(pollHosted, 2500);
      return;
    }
    const snap = res.data;
    if (h.lastTick >= 0 && snap.state.tick > h.lastTick + 1) {
      ui.announce('While you were away: ' + (snap.state.tick - h.lastTick) + ' actions were played. Score ' +
        snap.state.scoreA + '–' + snap.state.scoreB + '.');
    }
    h.lastTick = snap.state.tick;
    refreshHudHosted(snap.state, snap.waitingFor);
    if (snap.state.over) { hostedResults(snap.state); return; }
    h.pollTimer = setTimeout(pollHosted, 1500);
  }
  function pollHostedSoon() { if (G.hosted && G.hosted.transport !== 'rooms') { clearTimeout(G.hosted.pollTimer); pollHosted(); } }
  function stopHostedPolling() {
    if (G.hosted && G.hosted.client) G.hosted.client.leave();
    if (G.hosted && G.hosted.pollTimer) clearTimeout(G.hosted.pollTimer);
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
      modeLabel: G.hosted.transport === 'rooms' ? 'Online Match' : 'Hosted ' + G.hosted.code,
      objective: myTurn ? (state.phase === 'keeper' ? 'Your dive' : 'Your kick') : 'Opponent deciding…',
      phaseText: 'Score ' + state.scoreA + '–' + state.scoreB + (state.suddenDeath ? ' · sudden death' : '')
    });
    ui.setPanels(myTurn ? (state.phase === 'keeper' ? 'dive' : 'shoot') : 'wait');
    if (!myTurn) ui.setWaitText('Waiting for opponent…');
    render.setView(state.phase === 'keeper' ? 'keep' : 'shoot');
  }

  async function hostedConfirm() {
    const h = G.hosted, st = G.lastHostedState;
    if (!h || !st) return;
    if (G.lastHostedWaiting !== h.side) { ui.alertUser('Waiting for opponent.'); return; }
    if (!G.sel.zone) { ui.alertUser('Pick a goal zone first.'); return; }
    const cmd = {
      id: 'c' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
      tick: st.tick,
      type: st.phase === 'keeper' ? 'dive' : 'shoot',
      player: h.side,
      params: st.phase === 'keeper'
        ? { dir: G.sel.zone.dir, height: G.sel.zone.height, timing: G.sel.timing }
        : { dir: G.sel.zone.dir, height: G.sel.zone.height, curve: G.sel.curve }
    };
    const res = await platform.sendCommand(h.code, h.token, cmd);
    if (!res.ok) { ui.alertUser('Rejected: ' + res.error); audio.event('invalid'); return; }
    audio.event('ui-confirm');
    G.sel.zone = null;
    pollHostedSoon();
  }

  function hostedResults(state) {
    const won = state.winner === G.hosted.side;
    stopHostedPolling(); // match is over: clears G.hosted so Replay starts a local game
    audio.event('whistle-end');
    audio.event(won ? 'win' : 'lose');
    ui.renderResults({
      headline: won ? 'You win!' : 'You lose',
      nameA: 'Player A', nameB: 'Player B',
      breakdown: rules.breakdown(state),
      newAchievements: [],
      next: 'Authoritative result recorded by the server.'
    });
    setAppState('results');
  }

  // ---------- HUD ----------
  function refreshHud() {
    if (!G.match) return;
    const st = session.snapshot(G.match);
    let objective = '';
    if (G.mode === 'learn') objective = learnInstruction() || 'Tutorial complete — finish the set!';
    else if (G.config && G.config.goal && G.mode !== 'play') {
      objective = 'Goal: ' + G.config.goal.replace(/-/g, ' ') + ' · ' + (G.config.modeLabel || '');
    } else objective = G.config ? (G.config.modeLabel || 'Match') : 'Match';
    const phaseText = st.phase === 'keeper'
      ? (G.hotseat ? keeperName(st) + ' keeping' : (rules.keeperSide(st) === 'A' ? 'Your dive' : 'Rival guards'))
      : (G.hotseat ? shooterName(st) + ' shooting' : (st.shooter === 'A' ? 'Your kick' : 'Rival shoots'));
    ui.updateHud(st, {
      modeLabel: G.config ? G.config.modeLabel : 'Spot Kick',
      objective: objective,
      phaseText: phaseText + ' · kick ' + Math.min(st.kicksA + st.kicksB + 1, st.rounds * 2) + ' of ' + (st.rounds * 2) +
        (st.suddenDeath ? ' · SUDDEN DEATH' : '')
    });
    $('btn-undo').classList.toggle('hidden', G.mode !== 'practice' || G.match.undoStack.length === 0);
    audio.setTension(st.suddenDeath);
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
  }

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
    if (G.mode === 'hosted' && G.hosted) { hostedConfirm(); return; }
    origConfirm();
  };

  // boot when DOM ready
  window.SpotKickDebug = { G: G, rules: rules, session: session };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
