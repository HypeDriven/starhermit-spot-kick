// Spot Kick on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js),
// session (js/session.js) and save model (js/progress.js) are the browser
// build's, loaded as classic scripts (native/classic.ts); this module is what
// js/bootstrap.js did around them — the screen flow (title → setup → the
// countdown → shooting and keeping ⇄ pause → results), every mode (Quick
// Match vs the AI or two players on this device, Daily, Journey, Practice
// with undo, Challenge with its decision clock, Learn, Online Match), the
// zone, curve and timing choices by keys, pads, pointer and touch, the
// resolution animation, the results with achievements, the daily record and
// the goals posted to the leaderboard, and the lifecycle (a hidden window
// pauses a solo match). Screens are drawn by screens.ts (starhermit:ui), the
// stadium by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the countdown's beats (700 ms, then 350),
// the kick's flight and camera swing, the pause after a kick (900 ms, 250 with
// reduced motion), the Challenge's decision clock, the captions and toasts all
// run on a clock advanced 1/60 s per fixed step, so slow frames never change a
// match and play scripts replay exactly.
//
// Online matches are server-refereed: js/online.js over the platform's rooms,
// server.js decides every kick (see its header); this client only shows the
// snapshots it sends.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, primaryPointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn, type Room } from "starhermit:platform";
import { Content, Progress, Rules, SessionMod, type Achievement, type Breakdown, type KickEvent, type Session, type Stage, type State, type Theme, type Zone } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";
import { LobbyClient, MatchClient, createMatch, quickJoin } from "../js/online.js";

const BUILD = "1.0.0";
type Thunk = () => string;
export type Screen = "title" | "setup" | "play" | "results";
export type Overlay = "pause" | "settings" | "help" | "notice" | null;
export type SetupKind = "play" | "daily" | "journey" | "practice" | "challenge" | "online";
export interface Config extends Partial<Stage> {
  seed: number; rounds: number; aiDifficulty: number; goal: string; modeLabel: Thunk;
  stage?: Stage; challenge?: Stage; daily?: Stage; practice?: boolean; ranked?: boolean;
}
export interface Results {
  headline: Thunk; nameA: Thunk; nameB: Thunk; breakdown: Breakdown | null; elapsedMs?: number;
  achievements: Achievement[]; next: Thunk; extra?: Thunk; lb?: Thunk; board?: platform.BoardRow[] | null; nextLabel?: Thunk;
}

export const app = {
  screen: "title" as Screen,
  overlay: null as Overlay,
  openedFrame: 0,
  focusNext: null as string | null,
  appState: "title",
  mode: null as string | null,
  setup: "play" as SetupKind,
  setupRules: null as Thunk | null,
  config: null as Config | null,
  match: null as Session | null,
  humanSides: ["A"] as string[],
  hotseat: false,
  sel: { zone: null as Zone | null, curve: "none", timing: "on" },
  cursor: { dir: "center", height: "low" } as Zone,
  cursorShown: false,
  resolving: false,
  paused: false,
  panels: null as "shoot" | "dive" | "wait" | null,
  waitText: null as Thunk | null,
  decisionLeft: 0,
  decisionMs: 0,
  learnStep: 0,
  results: null as Results | null,
  notice: null as { title: Thunk; body: Thunk } | null,
  helpReturn: null as Overlay,
  captions: [] as { text: string; until: number }[],
  toasts: [] as { text: Thunk; until: number }[],
  // online
  lobby: null as LobbyClient | null,
  online: null as MatchClient | null,
  onlineStatus: null as Thunk | null,
  onlineBusy: false,
  hostedState: null as State | null,
  hostedWaiting: null as string | null,
  hostedLastTick: -1,
};
let clockMs = 0;
export const now = (): number => clockMs / 1000;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ the fixed-step scheduler (setTimeout's place)
let timers: { at: number; fn: () => void; id: number }[] = [];
let timerId = 0;
function after(ms: number, fn: () => void): number { const id = ++timerId; timers.push({ at: clockMs + ms, fn, id }); return id; }
function cancel(id: number): void { timers = timers.filter((t) => t.id !== id); }
function runTimers(): void {
  for (;;) {
    const due = timers.filter((t) => t.at <= clockMs);
    if (!due.length) return;
    timers = timers.filter((t) => t.at > clockMs);
    for (const t of due.sort((a, b) => a.at - b.at || a.id - b.id)) t.fn();
  }
}

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (turn, score, errors, results): one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).slice(-3).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
/** ui.alertUser: an assertive announcement and a toast. */
export function alertUser(text: string): void { announce(text, true); }
export function toast(text: Thunk): void {
  app.toasts.push({ text, until: now() + 3.2 });
  if (app.toasts.length > 3) app.toasts.shift();
  announce(text());
}
/** audio.js event with its caption (Settings › Captions). */
export function sound(ev: audio.Sfx): void {
  audio.play(ev);
  const c = audio.CAPTIONS[ev];
  if (c && platform.options.captions) { app.captions = [{ text: c, until: now() + 2.4 }]; }
}
function haptic(ms: number): void { try { vibrate(ms); } catch { /* none */ } }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
const ml = (c: Config | null): string => (c && c.modeLabel ? c.modeLabel() : "");
const WORD: Record<string, string> = { left: N("left"), center: N("center"), right: N("right"), high: N("high"), low: N("low"), none: N("none"), early: N("early"), on: N("on time"), late: N("late") };
const GOAL: Record<string, string> = { win: N("win"), "win-by-2": N("win by 2"), "clean-sheet": N("clean sheet") };
export const w = (v: string): string => T(WORD[v] ?? v);
export const zoneName = (z: Zone): string => T("{dir} {height}", { dir: w(z.dir), height: w(z.height) });
export const stageName = (st: Stage): string => (/Mastery/.test(st.name) ? T("Stage {n} — Mastery", { n: st.index ?? 0 }) : T("Stage {n}", { n: st.index ?? 0 }));
export function currentTheme(): Theme {
  if (ui.preferences().highContrast) return Content.THEMES.find((t) => t.id === "mono")!;
  return Content.THEMES.find((t) => t.id === platform.options.theme) ?? Content.THEMES[0]!;
}
export const save = (): ReturnType<typeof platform.progress> => platform.progress();

// ------------------------------------------------------------------ screens
function open(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.overlay = null;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function openOverlay(o: Overlay, focus: string | null = null): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function closeOverlay(): void {
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function showHelp(): void { app.helpReturn = app.overlay; openOverlay("help", "btn-close-help"); sound("ui-confirm"); }
export function closeHelp(): void {
  const back = app.helpReturn;
  app.helpReturn = null;
  if (back) openOverlay(back, back === "pause" ? "btn-resume" : "btn-back"); else closeOverlay();
  sound("ui-back");
}
export function showSettings(): void { openOverlay("settings", "btn-back"); }

// ------------------------------------------------------------------ mode setup (bootstrap.js setupPlay … setupChallenge)
const randSeed = (): number => (Math.random() * 0xffffffff) >>> 0;
export function setupPlay(): void {
  app.appState = "mode-select";
  app.setup = "play";
  app.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: "win", modeLabel: () => T("Quick Match") };
  app.setupRules = () => T("Five kicks each · sudden death on ties · about 3 minutes · unranked");
  open("setup", "btn-start-match");
  sound("ui-confirm");
}
export function setHotseat(on: boolean): void { app.hotseat = on; sound("ui-confirm"); }
export function dailyStage(): Stage { return Content.dailyFor(Content.utcDay(new Date(platform.nowMs()))); }
export function setupDaily(): void {
  app.appState = "mode-select";
  app.setup = "daily";
  const d = dailyStage();
  const done = save().dailyResults[d.day!];
  app.config = { ...d, modeLabel: () => T("Daily Challenge"), daily: d, ranked: !done };
  const hosted = platform.signedIn();
  app.setupRules = () => [T("Five kicks · Club keeper"), hosted ? T("first result recorded per UTC day") : T("ranked once per UTC day"),
    d.excluded ? T("excluded from the board") : (hosted ? T("counted on your profile") : T("ranked"))].join(" · ");
  open("setup", "btn-start-match");
  sound("ui-confirm");
}
export function journeyState(): { done: Set<string>; firstOpen: Stage | null } {
  const done = new Set(save().journeyDone);
  let firstOpen: Stage | null = null;
  Content.JOURNEY.forEach((st, idx) => {
    const locked = idx > 0 && !done.has(Content.JOURNEY[idx - 1]!.id) && !done.has(st.id);
    if (!done.has(st.id) && !locked && !firstOpen) firstOpen = st;
  });
  return { done, firstOpen };
}
export function stageLocked(idx: number, done: Set<string>): boolean {
  const st = Content.JOURNEY[idx]!;
  return idx > 0 && !done.has(Content.JOURNEY[idx - 1]!.id) && !done.has(st.id);
}
const journeyConfig = (st: Stage): Config => ({ ...st, modeLabel: () => T("Journey — {name}", { name: stageName(st) }), stage: st });
export function setupJourney(): void {
  app.appState = "mode-select";
  app.setup = "journey";
  const { firstOpen } = journeyState();
  app.config = firstOpen ? journeyConfig(firstOpen) : null;
  app.setupRules = () => T("Forty stages in four blocks: straight shots, then curve, then pressure, then mastery. Complete a stage to unlock the next.");
  open("setup", firstOpen ? "btn-start-match" : "btn-back");
  sound("ui-confirm");
}
export function pickStage(st: Stage): void { app.config = journeyConfig(st); sound("ui-confirm"); }
export function stageRulesText(st: Stage | Config): string {
  const c = st.constraints!;
  const bans: string[] = [];
  if (c.bannedCurves.length) bans.push(T("no {list} curve", { list: c.bannedCurves.map(w).join("/") }));
  if (c.bannedHeights.length) bans.push(T("{list} shots banned", { list: c.bannedHeights.map(w).join("/") }));
  if (c.bannedColumns.length) bans.push(T("no {list} shots", { list: c.bannedColumns.map(w).join("/") }));
  return T("{n} kicks each · AI: {ai} · goal: {goal}", { n: st.rounds!, ai: T(Content.PRACTICE_DIFFICULTIES[st.aiDifficulty!]!.name), goal: T(GOAL[st.goal!] ?? st.goal!) }) +
    (bans.length ? " · " + bans.join(", ") : "");
}
export function setupPractice(): void {
  app.appState = "mode-select";
  app.setup = "practice";
  app.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: "win", modeLabel: () => T("Practice"), practice: true };
  app.setupRules = () => T("Five kicks each · undo permitted · restart any time · unranked");
  open("setup", "btn-start-match");
  sound("ui-confirm");
}
export function setDifficulty(d: number): void { if (app.config) app.config.aiDifficulty = d; sound("ui-confirm"); }
export function setupChallenge(): void {
  app.appState = "mode-select";
  app.setup = "challenge";
  app.config = null; // require an explicit pick
  app.setupRules = () => T("Constrained rule sets. Pick one, then Start Match.");
  open("setup", "challenge-0");
  sound("ui-confirm");
}
export function pickChallenge(ch: Stage): void {
  app.config = { ...ch, modeLabel: () => T("Challenge — {name}", { name: T(ch.name) }), challenge: ch };
  sound("ui-confirm");
}
export function setupOnline(): void {
  if (!platform.signedIn()) return;
  app.appState = "mode-select";
  app.setup = "online";
  app.config = null;
  app.onlineStatus = null;
  app.setupRules = () => T("Private 1v1 shootout · refereed by the StarHermit server · reconnect supported");
  open("setup", "btn-create-online");
  sound("ui-confirm");
}

// ------------------------------------------------------------------ online matches (server-refereed)
const errText = (e: unknown): string => (e instanceof Error ? e.message : (e as { kind?: string })?.kind ?? String(e));
export function createOnline(joinFirst: boolean): void {
  if (app.onlineBusy) return;
  app.onlineBusy = true;
  app.onlineStatus = joinFirst ? () => T("Looking for an open match…") : () => T("Creating…");
  const p = joinFirst ? quickJoin(platform.adapter) : createMatch(platform.adapter).then((room: Room) => ({ room, created: true }));
  p.then((r: { room: Room; created: boolean }) => {
    app.onlineBusy = false;
    if (app.screen !== "setup" || app.setup !== "online") { void platform.adapter.leaveRoom(r.room.id).catch(() => undefined); return; }
    enterRoom(r.room, r.created, joinFirst);
  }, (e: unknown) => {
    app.onlineBusy = false;
    const error = errText(e);
    app.onlineStatus = () => T("Could not start an online match: {error} — solo modes work fine.", { error });
  });
}
function enterRoom(room: Room, created: boolean, joinFirst: boolean): void {
  if (room.status === "playing" && room.gameSessionId) { enterOnlineMatch(room); return; }
  if (room.status === "closed") { app.onlineStatus = () => T("The online match is no longer available."); return; }
  const lobby: LobbyClient = new LobbyClient(platform.adapter, room, {
    onPlaying: (r: Room) => { if (app.lobby === lobby) { lobby.close(); app.lobby = null; enterOnlineMatch(r); } },
    onClosed: () => { if (app.lobby === lobby) { app.lobby = null; app.onlineStatus = () => T("The online match is no longer available."); } },
  });
  app.lobby = lobby;
  lobby.connect();
  const host = lobby.host;
  app.onlineStatus = host
    ? (joinFirst && created ? () => T("No open match — created one. Waiting for an opponent…") : () => T("Match created — waiting for an opponent to join…"))
    : () => T("Joined — waiting for the host to start…");
  announce(host ? T("Online match created. You are the host.") : T("Joined an online match."));
}
export function cancelOnline(): void {
  const l = app.lobby;
  app.lobby = null;
  if (l) void l.leave();
  app.onlineStatus = null;
}
function enterOnlineMatch(room: Room): void {
  closeOnline();
  const m: MatchClient = new MatchClient(platform.adapter, room, {
    now: () => clockMs,
    hooks: {
      onSnap: (s: { state: State; waitingFor: string | null; kick: KickEvent | null }) => { if (app.online === m) onRoomsSnap(s); },
      onRejected: (reason: string) => {
        if (app.online !== m) return;
        alertUser(T("Rejected: {reason}", { reason: explainReason(reason) }));
        sound("invalid");
        refreshHostedHud();
      },
      onOver: () => { if (app.online === m && !app.resolving) roomsResults(); },
      onChange: () => {
        if (app.online === m && m.unavailable && !m.over) {
          leaveToTitle();
          toast(() => T("The online match is no longer available."));
        }
      },
    },
  });
  app.online = m;
  app.mode = "hosted";
  app.hotseat = false;
  app.match = null;
  app.hostedState = null;
  app.hostedWaiting = null;
  app.hostedLastTick = -1;
  app.config = { seed: 0, rounds: 5, aiDifficulty: 1, goal: "win", modeLabel: () => T("Online Match") };
  m.connect();
  render.resetPositions();
  render.setView("shoot", true);
  app.appState = "active";
  open("play");
  setPanels("wait");
  app.waitText = () => T("Connecting to the match…");
  sound("whistle-start");
}
function closeOnline(): void {
  if (app.online) { app.online.close(); app.online = null; }
}
export function hostedSide(): string | null { return app.online?.side ?? null; }
function onRoomsSnap(s: { state: State; waitingFor: string | null; kick: KickEvent | null }): void {
  if (app.hostedLastTick >= 0 && s.state.tick > app.hostedLastTick + 2 && !s.kick) {
    announce(T("While you were away: {n} actions were played. Score {a}–{b}.", { n: s.state.tick - app.hostedLastTick, a: s.state.scoreA, b: s.state.scoreB }));
  }
  app.hostedLastTick = s.state.tick;
  app.hostedState = s.state;
  app.hostedWaiting = s.waitingFor;
  if (s.kick) { animateResolution(s.kick, () => refreshHostedHud()); return; }
  if (!app.resolving) refreshHostedHud();
}
function refreshHostedHud(): void {
  const st = app.hostedState;
  if (!st || app.resolving) return;
  if (st.over || app.online?.over) { roomsResults(); return; }
  const me = hostedSide();
  const mine = !!me && app.hostedWaiting === me;
  if (mine && app.panels !== (st.phase === "keeper" ? "dive" : "shoot")) {
    resetSelection();
    announce(st.phase === "keeper" ? T("You are keeping. Pick a zone and timing.") : T("Your kick. Pick a zone, curve if you like, confirm."));
  }
  setPanels(mine ? (st.phase === "keeper" ? "dive" : "shoot") : "wait");
  if (!mine) app.waitText = () => T("Waiting for opponent…");
  const keep = st.phase === "keeper" && Rules.keeperSide(st) === me;
  if (render.currentCamera() !== (keep ? "keep" : "shoot")) render.setView(keep ? "keep" : "shoot");
}
function roomsConfirm(): void {
  const m = app.online, st = app.hostedState, me = hostedSide();
  if (!m || !st || !me) return;
  if (app.hostedWaiting !== me) { alertUser(T("Waiting for opponent.")); return; }
  if (!app.sel.zone) { alertUser(T("Pick a goal zone first.")); sound("invalid"); return; }
  const keeper = st.phase === "keeper";
  const params = keeper ? { dir: app.sel.zone.dir, height: app.sel.zone.height, timing: app.sel.timing } : { dir: app.sel.zone.dir, height: app.sel.zone.height, curve: app.sel.curve };
  sound(keeper ? "dive-committed" : "kick");
  haptic(20);
  m.send({ type: keeper ? "dive" : "shoot", tick: st.tick, id: `c${st.tick}-${me}`, params });
  app.sel.zone = null;
  render.showZoneHighlight(null);
  app.hostedWaiting = null; // until the script answers
  setPanels("wait");
  app.waitText = () => T("Waiting for opponent…");
}
function roomsResults(): void {
  const m = app.online;
  const over = m?.over as { winner: string; reason: string; breakdown: Breakdown } | null | undefined;
  const st = app.hostedState;
  if (!m || (!over && !(st && st.over))) return;
  if (app.screen === "results") return;
  const side = m.side;
  const winner = over ? over.winner : st!.winner;
  const won = winner === side;
  sound("whistle-end");
  sound(won ? "win" : "lose");
  const away = side !== "A";
  const forfeit = (over ? over.reason : st!.terminalReason) === "forfeit";
  app.results = {
    headline: () => (won ? T("You win!") : T("You lose")),
    nameA: () => (away ? T("Opponent") : T("You")),
    nameB: () => (away ? T("You (away)") : T("Opponent")),
    breakdown: over ? over.breakdown : Rules.breakdown(st!),
    achievements: [],
    next: forfeit ? (won ? () => T("Your opponent left — the match ended.") : () => T("You left the match.")) : () => T("Result recorded by the StarHermit server."),
  };
  app.appState = "results";
  open("results", "btn-menu");
  announce(app.results.headline(), true);
}

// ------------------------------------------------------------------ learn (bootstrap.js startLearn / advanceLearn)
export function startLearn(): void {
  app.mode = "learn";
  app.learnStep = 0;
  app.hotseat = false;
  app.config = { seed: 0x1eaa47, rounds: 3, aiDifficulty: 0, goal: "win", modeLabel: () => T("Learn") };
  startMatch();
}
function learnInstruction(): string | null {
  const step = Content.TUTORIAL_STEPS[app.learnStep];
  return step ? `${T(step.title)} — ${T(step.body)}` : null;
}
function advanceLearn(performed: string): void {
  const step = Content.TUTORIAL_STEPS[app.learnStep];
  if (!step) return;
  if (performed === step.require || (step.require === "shoot-curve" && performed === "shoot" && app.sel.curve !== "none")) {
    app.learnStep++;
    sound("achievement");
    if (app.learnStep >= Content.TUTORIAL_STEPS.length) {
      const s = save();
      s.tutorialDone = true;
      platform.persist();
      announce(T("Tutorial complete. You know every rule — play a match whenever you like."));
    } else announce(T("Step complete. {title}", { title: T(Content.TUTORIAL_STEPS[app.learnStep]!.title) }));
  }
}

// ------------------------------------------------------------------ match lifecycle
export function startConfiguredMatch(): void {
  const c = app.config;
  if (!c) { alertUser(T("Pick an option first.")); return; }
  app.mode = c.daily ? "daily" : c.stage ? "journey" : c.challenge ? "challenge" : c.practice ? "practice" : "play";
  startMatch();
}
let countdownTimer = 0;
function startMatch(): void {
  const c = app.config!;
  app.appState = "preparing";
  app.match = SessionMod.createSession({
    seed: c.seed, rounds: c.rounds, constraints: c.constraints ?? null, build: BUILD, contentVersion: Content.CONTENT_VERSION, mode: app.mode!,
    ai: app.hotseat ? null : { side: "B", difficulty: c.aiDifficulty || 0 },
  });
  app.humanSides = app.hotseat ? ["A", "B"] : ["A"];
  SessionMod.begin(app.match, platform.nowMs());
  app.results = null;
  app.resolving = false;
  app.paused = false;
  render.resetPositions();
  render.setView("shoot", true);
  countdown(() => {
    app.appState = "active";
    sound("whistle-start");
    pumpTurn();
  });
}
function countdown(done: () => void): void {
  app.appState = "countdown";
  open("play");
  setPanels("wait");
  let n = 3;
  const label = (): string => (app.mode === "learn" ? T("Learn") : (ml(app.config) || T("Match")));
  const step = (): void => {
    if (n > 0) {
      const k = n;
      app.waitText = () => `${label()} — ${k}`;
      announce(T("{label} starting in {n}", { label: label(), n }));
      sound("tick");
      n--;
      countdownTimer = after(700, step);
    } else {
      app.waitText = () => T("Play!");
      countdownTimer = after(350, done);
    }
  };
  step();
}
export function setPanels(p: typeof app.panels): void { app.panels = p; if (p === null) app.waitText = null; }

/** Decide whose input is needed and show the right panel; the AI acts when due (bootstrap.js pumpTurn). */
function pumpTurn(): void {
  const m = app.match;
  if (!m || app.paused) return;
  if (m.state.over) { onMatchOver(); return; }
  const aiRes = SessionMod.aiAct(m);
  const ev = lastKick(aiRes);
  if (ev) { animateResolution(ev, pumpTurn); return; }
  const cur = m.state;
  if (cur.over) { onMatchOver(); return; }
  const need = cur.phase === "keeper" ? Rules.keeperSide(cur) : cur.shooter;
  if (!app.humanSides.includes(need)) { after(60, pumpTurn); return; }
  resetSelection();
  if (cur.phase === "keeper") {
    setPanels("dive");
    render.setView("keep");
    announce(app.hotseat ? T("{name}: guard the goal. Pick a zone and timing.", { name: keeperName(cur) }) : T("You are keeping. Pick a zone and timing."));
  } else {
    setPanels("shoot");
    render.setView("shoot");
    announce(app.hotseat ? T("{name}: take the kick. Pick a zone, curve if you like, confirm.", { name: shooterName(cur) }) : T("Your kick. Pick a zone, curve if you like, confirm."));
  }
  armDecisionTimer();
}
function lastKick(results: { events?: { type: string }[] }[]): KickEvent | null {
  for (const r of results) {
    const ev = r.events?.find((e) => e.type === "kick-resolved");
    if (ev) return ev as unknown as KickEvent;
  }
  return null;
}
const keeperName = (st: State): string => (Rules.keeperSide(st) === "A" ? T("Player A") : T("Player B"));
const shooterName = (st: State): string => (st.shooter === "A" ? T("Player A") : T("Player B"));

function armDecisionTimer(): void {
  const limit = app.config?.constraints?.timeLimitMs;
  app.decisionMs = 0;
  if (!limit) return;
  app.decisionMs = platform.options.timingAssist ? limit * 2 : limit;
  app.decisionLeft = app.decisionMs;
}
function clearDecisionTimer(): void { app.decisionMs = 0; }
function decisionTick(): void {
  if (!app.decisionMs || app.paused || app.appState !== "active") return;
  app.decisionLeft -= 1000 / 60;
  if (app.decisionLeft <= 0) { clearDecisionTimer(); autoCommit(); }
}
export function clockText(): string { return app.decisionMs ? `${Math.max(0, Math.ceil(app.decisionLeft / 1000))}s` : ""; }
function autoCommit(): void {
  const st = app.match!.state;
  if (st.phase === "keeper") { app.sel.zone = { dir: "center", height: "low" }; app.sel.timing = "on"; }
  else {
    const first = Rules.legalActions(st)[0];
    app.sel.zone = first ? { dir: first.params.dir!, height: first.params.height! } : { dir: "center", height: "low" };
    app.sel.curve = "none";
  }
  announce(T("Time expired — default choice committed."));
  confirmSelection();
}

// ------------------------------------------------------------------ selection / commit
function resetSelection(): void {
  app.sel = { zone: null, curve: "none", timing: "on" };
  render.showZoneHighlight(app.cursorShown ? app.cursor : null);
}
export function currentState(): State | null { return app.match ? app.match.state : app.hostedState; }
export function myTurn(): boolean {
  if (app.appState !== "active" || app.resolving || app.paused) return false;
  if (app.mode === "hosted") { const me = hostedSide(); return !!me && app.hostedWaiting === me; }
  return !!app.match && (app.panels === "shoot" || app.panels === "dive");
}
export function pickZone(zone: Zone): void {
  if (!myTurn()) return;
  const st = currentState();
  if (!st || st.over) return;
  if (st.phase !== "keeper") {
    const test = Rules.isLegalShot(st, { dir: zone.dir, height: zone.height, curve: app.sel.curve });
    if (!test.ok) { alertUser(T("Invalid target: {reason}", { reason: explainReason(test.reason!) })); sound("invalid"); return; }
  }
  app.sel.zone = zone;
  app.cursor = { ...zone };
  render.showZoneHighlight(zone);
  sound("ui-confirm");
  haptic(12);
  announce(selectionText());
}
export function setCurve(c: string): void { app.sel.curve = c; sound("ui-confirm"); }
export function setTiming(t: string): void { app.sel.timing = t; sound("ui-confirm"); }
function cycleCurve(d: number): void {
  const cs = Rules.CURVES;
  app.sel.curve = cs[(cs.indexOf(app.sel.curve) + d + cs.length) % cs.length]!;
}
/** The selection line under the panel, and whether Kick!/Dive! is enabled. */
export function selection(): { text: string; ok: boolean } {
  const st = currentState();
  if (!st || !app.sel.zone) return { text: T("No zone selected"), ok: false };
  if (st.phase === "keeper") return { text: T("Dive {zone} · {timing}", { zone: zoneName(app.sel.zone), timing: w(app.sel.timing) }), ok: true };
  const test = Rules.isLegalShot(st, { dir: app.sel.zone.dir, height: app.sel.zone.height, curve: app.sel.curve });
  return {
    text: T("Shot {zone}", { zone: zoneName(app.sel.zone) }) + (app.sel.curve !== "none" ? " · " + T("curve {dir}", { dir: w(app.sel.curve) }) : "") +
      (test.ok ? "" : " — " + explainReason(test.reason!)),
    ok: test.ok,
  };
}
const selectionText = (): string => selection().text;
const REASONS: Record<string, string> = {
  "column-banned": N("that column is banned in this challenge"), "height-banned": N("that height is banned in this challenge"),
  "curve-banned": N("that curve is banned in this challenge"), "bad-direction": N("unknown direction"), "bad-height": N("unknown height"),
  "bad-curve": N("unknown curve"), "bad-timing": N("unknown timing"), "out-of-turn": N("not your turn"), "match-over": N("the match is over"),
  "not-your-side": N("not your side"), rejected: N("command rejected"), "stale-tick": N("not your turn"),
};
export function explainReason(r: string): string { return REASONS[r] ? T(REASONS[r]!) : r; }

export function confirmSelection(): void {
  if (app.mode === "hosted") { roomsConfirm(); return; }
  if (!myTurn() || !app.match) return;
  const st = app.match.state;
  if (!app.sel.zone) { alertUser(T("Pick a goal zone first.")); sound("invalid"); return; }
  clearDecisionTimer();
  let res, performed;
  if (st.phase === "keeper") {
    res = SessionMod.submit(app.match, "dive", Rules.keeperSide(st), { dir: app.sel.zone.dir, height: app.sel.zone.height, timing: app.sel.timing });
    performed = "dive";
  } else {
    res = SessionMod.submit(app.match, "shoot", st.shooter, { dir: app.sel.zone.dir, height: app.sel.zone.height, curve: app.sel.curve });
    performed = "shoot";
  }
  if (!res.ok) { alertUser(T("Invalid action: {reason}", { reason: explainReason(res.reason!) })); sound("invalid"); return; }
  sound(st.phase === "keeper" ? "dive-committed" : "kick");
  haptic(20);
  if (app.mode === "learn") advanceLearn(performed);
  const kick = (res.events ?? []).find((e) => e.type === "kick-resolved") as unknown as KickEvent | undefined;
  if (kick) animateResolution(kick, pumpTurn);
  else pumpTurn();
}

// ------------------------------------------------------------------ resolution → results
let postKick = 0;
function animateResolution(ev: KickEvent, next: () => void): void {
  app.resolving = true;
  app.appState = "resolving";
  setPanels(null);
  app.sel.zone = null;
  render.showZoneHighlight(null);
  render.playKick(ev, () => {
    app.resolving = false;
    app.appState = "active";
    const word = ev.outcome === "goal" ? T("GOAL") : ev.outcome === "saved" ? T("SAVED") : T("OFF TARGET");
    lastOutcome = { text: word, until: now() + 1.2, kind: ev.outcome };
    announce(`${word} — ${describeKick(ev)}`);
    sound(ev.outcome === "goal" ? "goal" : ev.outcome === "saved" ? "save" : "offtarget");
    if (ev.outcome === "goal") haptic(80);
    app.resolving = true; // the pause after the kick: input stays locked
    postKick = after(preferences().reducedMotion ? 250 : 900, () => {
      app.resolving = false;
      render.resetPositions();
      if (app.mode === "hosted") { refreshHostedHud(); return; }
      if (app.match && app.match.state.over) onMatchOver();
      else next();
    });
  });
}
export let lastOutcome: { text: string; until: number; kind: string } | null = null;
function describeKick(ev: KickEvent): string {
  const side = hostedSide();
  const mine = app.mode === "hosted" ? ev.shooter === side : ev.shooter === "A";
  const who = app.hotseat ? (ev.shooter === "A" ? T("Player A") : T("Player B")) : mine ? T("You") : T("Rival");
  return T(ev.shot.curve !== "none" ? "{who} shot {zone} with {curve} curve; keeper went {dive} ({timing})" : "{who} shot {zone}; keeper went {dive} ({timing})", {
    who, zone: zoneName(ev.shot), curve: w(ev.shot.curve), dive: zoneName(ev.dive), timing: w(ev.dive.timing),
  });
}
export function skipAnim(): void {
  render.skip();
  if (postKick && app.resolving && !render.animating()) {
    const t = timers.find((x) => x.id === postKick);
    if (t) { cancel(postKick); postKick = 0; t.fn(); }
  }
}
export function doUndo(): void {
  if (!app.match || app.mode !== "practice" || app.resolving) return;
  const res = SessionMod.undo(app.match);
  if (res.ok) {
    render.resetPositions();
    sound("ui-back");
    announce(T("Undone."));
    app.appState = "active";
    pumpTurn();
  } else alertUser(T("Nothing to undo."));
}
export function canUndo(): boolean { return app.mode === "practice" && !!app.match && app.match.undoStack.length > 0 && !app.resolving; }
export function resetCamera(): void {
  const st = currentState();
  const keep = !!st && st.phase === "keeper" && (app.mode === "hosted" ? Rules.keeperSide(st) === hostedSide() : app.humanSides.includes(Rules.keeperSide(st)));
  render.setView(keep ? "keep" : "shoot");
  sound("ui-confirm");
}

function onMatchOver(): void {
  clearDecisionTimer();
  const m = app.match!;
  const st = m.state;
  const verify = SessionMod.verifyReplay(m);
  if (!verify.ok) console.error(`replay verification failed: ${verify.reason}`);
  const humanWon = app.hotseat ? null : st.winner === "A";
  const hot = app.hotseat;
  sound("whistle-end");
  sound(humanWon === false ? "lose" : "win");
  const s = save();
  const newAch: Achievement[] = [];
  const unlock = (key: string): void => { const a = Progress.unlock(s, key, Math.round(platform.nowMs())); if (a) { newAch.push(a); sound("achievement"); } };
  s.stats.matches++;
  s.stats.goals += st.scoreA;
  s.stats.saves += st.savesA;
  s.stats.curvedGoals += st.log.filter((l) => l.s === "A" && l.o === "goal" && l.sh[2] !== "none").length;
  if (!hot) {
    if (st.scoreA > 0) unlock("first_goal");
    if (s.stats.curvedGoals >= 3) unlock("curve_master");
    if (s.stats.saves >= 10) unlock("keeper_10");
    if (humanWon) {
      s.stats.wins++;
      s.streak++;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      unlock("first_win");
      if (s.streak >= 3) unlock("streak_3");
    } else s.streak = 0;
  }
  let next: Thunk = () => "";
  let nextLabel: Thunk | undefined;
  const c = app.config!;
  if (app.mode === "journey" && c.stage) {
    const stg = c.stage;
    if (stageGoalMet(stg, st)) {
      if (!s.journeyDone.includes(stg.id)) s.journeyDone.push(stg.id);
      if (s.journeyDone.length >= 10) unlock("journey_10");
      if (s.journeyDone.length >= 40) unlock("journey_40");
      const nDone = s.journeyDone.length;
      next = nDone < Content.JOURNEY.length ? () => T("Next recommended: Stage {n}", { n: nDone + 1 }) : () => T("Journey complete — try the daily challenge.");
    } else next = () => T("Goal not met ({goal}). Retry the stage.", { goal: T(GOAL[stg.goal] ?? stg.goal) });
    nextLabel = () => T("Next");
  }
  let board = false;
  if (app.mode === "daily" && c.daily) {
    const day = c.daily.day!;
    if (!s.dailyResults[day]) {
      s.dailyResults[day] = { won: !!humanWon, score: `${st.scoreA}–${st.scoreB}`, hash: Rules.hashState(st) };
      s.stats.dailies++;
      if (s.stats.dailies >= 7) unlock("daily_7");
      board = true;
    }
    next = () => T("Next daily arrives at 00:00 UTC.");
  }
  if (app.mode === "learn") next = () => T("Tutorial done — Quick Match is one tap away on the menu.");
  platform.persist();
  const hash = Rules.hashState(st);
  const env = m.envelope.result;
  const r: Results = {
    headline: () => (hot ? (st.winner === "A" ? T("Player A wins!") : T("Player B wins!")) : humanWon ? T("You win!") : T("Rival wins")),
    nameA: () => (hot ? T("Player A") : T("You")),
    nameB: () => (hot ? T("Player B") : T("Rival")),
    breakdown: env ? env.breakdown : Rules.breakdown(st),
    elapsedMs: env ? env.elapsedMs : 0,
    achievements: newAch, next, ...(nextLabel ? { nextLabel } : {}),
    extra: () => (verify.ok ? T("Replay verified: yes · final hash {hash}", { hash }) : T("Replay verified: NO — {reason} · final hash {hash}", { reason: verify.reason ?? "", hash })),
  };
  app.results = r;
  // Signed in: every finished match against the AI (Quick Match, Journey, Daily) posts the player's goals.
  const post = platform.signedIn() && !hot && (app.mode === "play" || app.mode === "journey" || app.mode === "daily");
  if (post) {
    let lb: platform.Posted | null = null;
    r.lb = () => (!lb ? S("lbPosting") : !lb.posted ? S("lbFailed") : lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted"));
    void platform.postGoals(st.scoreA).then((res) => {
      lb = res;
      if (board) void platform.topEntries(10).then((b) => { r.board = b; });
    });
  }
  app.appState = "results";
  open("results", app.mode === "journey" ? "btn-next" : "btn-replay");
  announce(`${r.headline()} ${st.scoreA}–${st.scoreB}`, true);
}
function stageGoalMet(stg: Stage, st: State): boolean {
  if (st.winner !== "A") return false;
  if (stg.goal === "win-by-2") return st.scoreA - st.scoreB >= 2;
  if (stg.goal === "clean-sheet") return st.scoreB === 0;
  return true;
}
export function replayMatch(): void {
  if (app.mode === "hosted") {
    closeOnline();
    app.mode = "play";
    app.hotseat = false;
    app.config = { seed: randSeed(), rounds: 5, aiDifficulty: 1, goal: "win", modeLabel: () => T("Quick Match") };
  } else if (app.config && !app.config.stage && !app.config.daily && !app.config.challenge && app.mode !== "learn") app.config.seed = randSeed();
  if (app.config) startMatch();
}
export function nextMatch(): void {
  if (app.mode === "journey") {
    const done = save().journeyDone;
    const nextStage = Content.JOURNEY.find((s) => !done.includes(s.id));
    if (nextStage) { app.config = journeyConfig(nextStage); startMatch(); return; }
  }
  leaveToTitle();
}
export function leaveToTitle(): void {
  clearDecisionTimer();
  cancel(countdownTimer);
  cancel(postKick);
  if (app.online) { const m = app.online; app.online = null; void m.leave(); }
  cancelOnline();
  app.match = null;
  app.paused = false;
  app.resolving = false;
  app.hostedState = null;
  setPanels(null);
  app.appState = "title";
  render.resetPositions();
  render.setView("shoot", true);
  open("title", "btn-play");
  sound("ui-back");
}

// ------------------------------------------------------------------ pause / settings
export function pause(): void {
  if (app.appState !== "active" || app.overlay) return;
  if (app.mode !== "hosted") app.paused = true;
  app.appState = app.mode === "hosted" ? "active" : "paused";
  openOverlay("pause", "btn-resume");
  announce(T("Paused."));
  sound("ui-back");
}
export function resume(): void {
  if (app.overlay === "settings") { closeOverlay(); return; }
  app.paused = false;
  closeOverlay();
  if (app.appState === "paused") app.appState = "active";
  announce(T("Resumed."));
  sound("ui-confirm");
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(() => S("copied")); } catch { toast(() => `${S("copyFailed")}: ${link}`); }
}

// ------------------------------------------------------------------ HUD text (bootstrap.js refreshHud / refreshHudHosted)
export function hudText(): { mode: string; objective: string; phase: string } {
  const st = currentState();
  if (!st) return { mode: ml(app.config), objective: "", phase: "" };
  if (app.mode === "hosted") {
    const me = hostedSide();
    const mine = !!me && app.hostedWaiting === me;
    return {
      mode: T("Online Match"),
      objective: mine ? (st.phase === "keeper" ? T("Your dive") : T("Your kick")) : T("Opponent deciding…"),
      phase: T("Score {a}–{b}", { a: st.scoreA, b: st.scoreB }) + (st.suddenDeath ? " · " + T("sudden death") : ""),
    };
  }
  let objective: string;
  if (app.mode === "learn") objective = learnInstruction() || T("Tutorial complete — finish the set!");
  else if (app.config && app.config.goal && app.mode !== "play") objective = T("Goal: {goal}", { goal: T(GOAL[app.config.goal] ?? app.config.goal) }) + " · " + ml(app.config);
  else objective = ml(app.config) || T("Match");
  const phaseText = st.phase === "keeper" || st.phase === "over"
    ? (app.hotseat ? T("{name} keeping", { name: keeperName(st) }) : (Rules.keeperSide(st) === "A" ? T("Your dive") : T("Rival guards")))
    : (app.hotseat ? T("{name} shooting", { name: shooterName(st) }) : (st.shooter === "A" ? T("Your kick") : T("Rival shoots")));
  return {
    mode: ml(app.config) || "Spot Kick", objective,
    phase: phaseText + " · " + T("kick {n} of {total}", { n: Math.min(st.kicksA + st.kicksB + 1, st.rounds * 2), total: st.rounds * 2 }) + (st.suddenDeath ? " · " + T("SUDDEN DEATH") : ""),
  };
}

// ------------------------------------------------------------------ keys and pads (bootstrap.js onKey / pollGamepad)
const PLAY_ACTIONS = new Set(["left", "right", "high", "low", "confirm", "curve_left", "curve_right", "early", "on_time", "late"]);
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "help") { if (app.overlay !== "help") later(showHelp); return; }
  if (app.overlay) {
    if (a !== "pause" || !fresh()) return;
    if (app.overlay === "help") later(closeHelp);
    else if (app.overlay === "pause" || app.overlay === "settings") later(resume);
    else if (app.overlay === "notice") later(closeOverlay);
    return;
  }
  if (app.screen === "setup" && a === "pause" && fresh()) { later(() => { if (app.lobby) cancelOnline(); leaveToTitle(); }); return; }
  if (app.screen !== "play" || app.appState === "countdown") return;
  switch (a) {
    case "pause": later(pause); return;
    case "undo": later(doUndo); return;
    case "camera": later(resetCamera); return;
    case "skip": later(skipAnim); return;
  }
  if (!PLAY_ACTIONS.has(a) || !myTurn()) return;
  if (ui.focused() !== null) {
    if (a === "confirm") return; // Enter / Space on a focused tray button are the button's
    ui.setFocus(null);
  }
  const cols = Rules.COLUMNS;
  let i = cols.indexOf(app.cursor.dir);
  const showCursor = (): void => { app.cursorShown = true; render.showZoneHighlight(app.sel.zone ?? app.cursor); };
  switch (a) {
    case "left": i = Math.max(0, i - 1); break;
    case "right": i = Math.min(cols.length - 1, i + 1); break;
    case "high": app.cursor.height = "high"; break;
    case "low": app.cursor.height = "low"; break;
    case "curve_left": later(() => cycleCurve(-1)); return;
    case "curve_right": later(() => cycleCurve(1)); return;
    case "early": later(() => setTiming("early")); return;
    case "on_time": later(() => setTiming("on")); return;
    case "late": later(() => setTiming("late")); return;
    case "confirm": later(() => { if (app.sel.zone) confirmSelection(); else pickZone({ ...app.cursor }); }); return;
  }
  app.cursor = { dir: cols[i]!, height: app.cursor.height };
  app.sel.zone = null; // moving the cursor drops the selected zone (as Enter re-selects)
  showCursor();
  render.showZoneHighlight(app.cursor);
  sound("ui-focus");
});

// ------------------------------------------------------------------ pointer and touch on the goal (render.js bindPointer)
/** The goal's view rectangle in window pixels (the canvas area the HUD leaves), set by screens.ts. */
export const view: render.Rect = { x: 0, y: 0, width: 0, height: 0 };
const inView = (x: number, y: number): boolean => x >= view.x && y >= view.y && x <= view.x + view.width && y <= view.y + view.height;
let downAt: { x: number; y: number; t: number } | null = null;
const taps: { x: number; y: number }[] = [];
let hover: { x: number; y: number } | null = null;
let lastTouch = -1e9;
function release(x: number, y: number): void {
  if (!downAt) return;
  const dist = Math.hypot(x - downAt.x, y - downAt.y) / frame().scale;
  const dt = now() - downAt.t;
  downAt = null;
  if (dist > 14 || dt > 0.8) return; // a drag or long press, not a tap
  taps.push({ x, y });
}
onTouch((e) => {
  lastTouch = now();
  if (e.control || !e.primary) return;
  if (e.phase === "start") downAt = inView(e.x, e.y) ? { x: e.x, y: e.y, t: now() } : null;
  else if (e.phase === "end") release(e.x, e.y);
  else if (e.phase === "cancel") downAt = null;
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) downAt = inView(e.x, e.y) && !ui.pointerOver() ? { x: e.x, y: e.y, t: now() } : null;
  else release(e.x, e.y);
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) hover = { x, y }; });
let hoverZone = "";
/** Taps on the goal pick a zone; hovering previews it (legal-target preview). */
function pointerInput(wasPlaying: boolean): void {
  const list = taps.splice(0);
  const h = hover;
  hover = null;
  if (!wasPlaying || !myTurn() || app.screen !== "play" || app.overlay) return;
  if (h) {
    const z = inView(h.x, h.y) && !ui.pointerOver() ? render.pickZone(h.x, h.y) : null;
    const k = z ? `${z.dir}:${z.height}` : "";
    if (k !== hoverZone) {
      hoverZone = k;
      render.showZoneHighlight(z ?? app.sel.zone ?? (app.cursorShown ? app.cursor : null));
      if (z) announce(T("Zone {zone}", { zone: zoneName(z) }));
    }
  }
  for (const p of list) {
    if (!inView(p.x, p.y)) continue;
    const z = render.pickZone(p.x, p.y);
    if (!z) continue;
    ui.setFocus(null);
    pickZone(z);
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  render.step(1 / 60);
  decisionTick();
  runTimers();
  app.online?.update();
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
let themeKey = "";
function applyTheme(): void {
  const t = currentTheme();
  if (t.id === themeKey) return;
  themeKey = t.id;
  render.build(t);
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  const check = Content.validateContent();
  if (!check.ok) console.error(`content validation failed: ${check.errors.join("; ")}`);
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyTheme();
  render.setView("shoot", true);
  render.setActive(true);
  open("title", "btn-play");
  void resumeRoom();
});
/** A room the player still holds a seat in drops them back into its lobby or match (reconnect). */
async function resumeRoom(): Promise<void> {
  const room = await platform.myRoom();
  if (!room || app.screen !== "title") return;
  if (room.status === "playing" && room.gameSessionId) enterOnlineMatch(room);
  else if (room.status === "lobby" || room.status === "open") { setupOnline(); enterRoom(room, false, false); }
}
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => applyTheme());
platform.onProgressMerged(() => { if (app.screen === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
platform.onPlayer(() => {
  if (!platform.signedIn() && (app.online || app.lobby || app.setup === "online")) {
    if (app.screen !== "title" && (app.mode === "hosted" || app.setup === "online")) leaveToTitle();
  }
});
onSessionEnded((reason) => {
  const terms = reason === "terms-required";
  const wasOnline = !!app.online || !!app.lobby;
  if (wasOnline) leaveToTitle();
  if (wasOnline || terms || reason === "expired") {
    app.notice = { title: () => (terms ? S("termsTitle") : S("expiredTitle")), body: () => (terms ? S("termsBody") : S("expiredBody")) };
    openOverlay("notice", "btn-notice-local");
    announce(app.notice.title(), true);
  } else toast(() => S("signedOut"));
});
onSuspend(() => {
  hidden = true;
  // a hidden window pauses a solo match (bootstrap.js onVisibility)
  if (app.appState === "active" && app.mode !== "hosted" && !app.overlay && app.screen === "play") pause();
  platform.flush();
});
onResume(() => { hidden = false; });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  applyTheme();
  audio.update();
  const st = currentState();
  audio.setTension(!!st && st.suddenDeath && app.screen === "play");
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until >= t);
  app.captions = app.captions.filter((x) => x.until >= t);
  if (lastOutcome && lastOutcome.until < t) lastOutcome = null;
});
onRender(() => {
  const wasPlaying = myTurn() && app.screen === "play" && !app.overlay;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const f = frame();
  render.update(frameDt, f.width, f.height, view, ui.preferences().scale);
  flushAnnouncements();
});
export { primaryPointer };
