// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame over the stadium: the status bar (mode,
// score, the Challenge's decision clock), the HUD top (objective, phase, the
// kick dots), the shot / dive tray (the six-zone grid mirroring the goal, the
// curve or timing segment, the selection line, Kick! / Dive!) or the wait
// line, the action buttons (pause, skip, undo in Practice, reset camera), the
// captions above the tray, named targets over the six goal zones (the old
// picking's DOM equivalent: screen readers and play scripts find them), the
// toasts, and every screen and overlay (title, setup, results; pause /
// settings, help, the session notice). The old media queries are layouts
// picked by the window's logical size: wide (≥ 560 px: the zone grid beside
// the segment), portrait (the tray stacked), short landscape (≤ 500 px tall:
// the tray a left column, the actions a right column, the goal between). The
// goal's view rectangle (the canvas area the HUD leaves, as syncSafeInsets
// measured it) goes to main.ts (view → render.ts).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Progress, type Stage, type Zone } from "./classic.ts";
import { S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, canUndo, cancelOnline, clockText, closeHelp, closeOverlay, confirmSelection, createOnline, currentState, currentTheme, dailyStage,
  doUndo, fresh, hudText, invite, journeyState, later, leaveToTitle, myTurn, nextMatch, pause, pickChallenge, pickStage, pickZone,
  replayMatch, resetCamera, resume, selection, setCurve, setDifficulty, setHotseat, setTiming, setupChallenge, setupDaily, setupJourney,
  setupOnline, setupPlay, setupPractice, showHelp, showSettings, signIn, skipAnim, sound, stageLocked, stageName, stageRulesText,
  startConfiguredMatch, startLearn, view, zoneName,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; land: boolean; fw: number; fh: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const land = lw > lh && lh <= 500;
  return { lw, lh, sc, wide: lw >= 560 && !land, land, fw: f.width / sc, fh: f.height / sc };
}
const lastSize = new Map<string, ui.Rect>();
const hOf = (k: string, L: Layout, fallback = 0): number => (lastSize.get(k)?.height ?? fallback * L.sc) / L.sc;
const wOf = (k: string, L: Layout, fallback = 0): number => (lastSize.get(k)?.width ?? fallback * L.sc) / L.sc;
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; quiet?: boolean;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 24; // a label wider than its button wraps (labels don't)
    opts.content = () => { ui.style(b.disabled ? "wrap-dim" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style("face").label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) {
    later(() => { if (!b.quiet) sound("ui-confirm"); b.act(); });
  }
}
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, justify: "start" | "center" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const bwid = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + bwid > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bwid;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function toWindow(x: number, y: number, wd: number, h: number): ui.Rect {
  const sc = ui.preferences().scale, sa = frame().safeArea;
  return { x: sa.left + x * sc, y: sa.top + y * sc, width: wd * sc, height: h * sc };
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "play") hud(L);
  else Object.assign(view, { x: 0, y: 0, width: f.width, height: f.height });
  if (app.screen === "title") page("Spot Kick", "screen-bg", L, (wd) => titlePage(wd, L));
  else if (app.screen === "setup") page(T("Setup"), "screen-bg", L, (wd) => setupPage(wd, L));
  else if (app.screen === "results") page(T("Results"), "screen-bg", L, (wd) => resultsPage(wd, L));
  if (app.overlay) overlay(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A full-window screen over the stadium (.screen): content centred, scrolling from the top when taller. */
function page(label: string, cls: string, L: Layout, build: (w: number) => void, onBack?: () => void): void {
  const key = `page-${label}`;
  const pad = L.land ? 12 : 20;
  const wd = Math.min(L.lw - 2 * pad, 720);
  const ch = hOf(key, L, 400);
  const scroll = ch > L.lh - 2 * pad;
  const opening = frame().frame - app.openedFrame <= 6;
  const sa = frame().safeArea;
  const isOpen = ui.dialog(label, "", true, () => {
    ui.column(`${key}-bg`, () => {
      const body = (): void => {
        lastSize.set(key, ui.column(`${key}-in`, () => build(scroll ? wd - 14 : wd), { spacing: 10, width: scroll ? wd - 14 : wd, align: "center" }));
      };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: wd + 6, height: L.lh - 2 * pad }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, {
      style: cls, width: L.fw, height: L.fh, align: "center", justify: scroll ? "start" : "center",
      padding: { top: sa.top / L.sc + pad, bottom: sa.bottom / L.sc + pad, start: sa.left / L.sc, end: sa.right / L.sc },
    });
  });
  if (!isOpen && fresh() && !app.overlay) later(onBack ?? (() => { if (app.screen !== "title") leaveToTitle(); }));
}

// ------------------------------------------------------------------ the title (screen-title)
function titlePage(wd: number, L: Layout): void {
  para("SPOT KICK", wd, L.land ? "title-name-sm" : "title-name", "title-heading");
  para(T("Penalty shootout duel under the floodlights"), wd, "subtitle", "title-sub");
  const s = Progress.normalize(platform.progress());
  const list: Btn[] = [
    { id: "btn-play", text: T("Play"), act: setupPlay },
    { id: "btn-daily", text: T("Daily Challenge"), act: setupDaily },
    {
      id: "btn-journey", text: T("Journey"), name: `${T("Journey")} ${s.journeyDone.length}/${Content.JOURNEY.length}`, act: setupJourney,
      content: () => ui.row("journey-face", () => {
        ui.style(L.land ? "face-sm" : "face").label(T("Journey"));
        ui.row("journey-pill", () => ui.style("pill-text").label(`${s.journeyDone.length}/${Content.JOURNEY.length}`), { style: "pill" });
      }, { spacing: 8, align: "center" }),
    },
    { id: "btn-practice", text: T("Practice"), act: setupPractice },
    { id: "btn-challenge", text: T("Challenge"), act: setupChallenge },
    { id: "btn-learn", text: T("Learn"), act: startLearn },
  ];
  if (platform.signedIn()) list.push({ id: "btn-online", text: T("Online Match"), act: setupOnline });
  list.push({ id: "btn-help", text: T("Help"), act: showHelp, quiet: true });
  list.push({ id: "btn-settings", text: T("Settings"), act: showSettings });
  if (!platform.signedIn()) list.push({ id: "btn-signin", text: S("signIn"), act: signIn });
  else if (platform.inviteLink()) list.push({ id: "btn-invite", text: S("invite"), act: invite });
  if (L.land) {
    // short landscape: a compact heading and a 3-column grid so it fits without scrolling
    const gw = Math.min(wd, 640), cols = 3, gap = 8, cw = (gw - (cols - 1) * gap) / cols;
    ui.column("menu-grid", () => {
      for (let r = 0; r * cols < list.length; r++) {
        ui.row(`menu-r${r}`, () => { for (const b of list.slice(r * cols, r * cols + cols)) button({ ...b, style: "btn-menu-sm", width: cw }); }, { spacing: gap });
      }
    }, { spacing: gap, width: gw });
  } else {
    const mw = Math.min(0.78 * L.lw, 340);
    ui.column("menu", () => { for (const b of list) button({ ...b, style: "btn-menu", width: mw }); }, { spacing: 8, width: mw });
  }
  para(profileLine(), wd, "center-dim", "title-profile");
}
function profileLine(): string {
  const s = Progress.normalize(platform.progress());
  const m = s.stats.matches;
  const stats = m ? T("{wins} wins in {matches} matches · best streak {streak}", { wins: s.stats.wins, matches: m, streak: s.bestStreak }) : null;
  if (platform.signedIn()) {
    const st = platform.syncState();
    const sync = T(st === "synced" ? "synced" : st === "saving" || st === "connecting" ? "saving…" : "offline");
    return T("Playing as {name} · cloud save {sync}", { name: platform.displayName() || "…", sync }) + (stats ? " · " + stats : "");
  }
  return m ? `${T("Guest profile")} · ${stats}` : T("Guest profile — progress is stored on this device");
}

// ------------------------------------------------------------------ setup (screen-setup)
const SETUP_TITLE: Record<string, string> = { play: "Quick Match", daily: "Daily Challenge", journey: "Journey", practice: "Practice", challenge: "Challenge", online: "Online Match" };
function setupPage(wd: number, L: Layout): void {
  const bw = Math.min(wd, 70 * 8.5);
  para(T(SETUP_TITLE[app.setup] ?? "Setup"), bw, "h2", "setup-title");
  const c = app.config;
  let rules = app.setupRules ? app.setupRules() : "";
  if ((app.setup === "journey" || app.setup === "challenge") && c && (c.stage || c.challenge)) rules = stageRulesText(c);
  if (app.setup === "journey" && !c) rules = T("Journey complete — every stage finished. Try the daily challenge.");
  para(rules, bw, "center-dim", "setup-rules");
  switch (app.setup) {
    case "play": {
      para(T("A five-kick shootout. You shoot first, then guard the goal."), bw, "center-dim", "setup-desc");
      segRow("vs", [
        { id: "vs-ai", text: T("Vs AI (Club)"), selected: !app.hotseat, act: () => setHotseat(false), quiet: true },
        { id: "vs-hotseat", text: T("Two players · this device"), selected: app.hotseat, act: () => setHotseat(true), quiet: true },
      ], bw, "btn-seg");
      break;
    }
    case "daily": {
      const d = dailyStage();
      const done = Progress.normalize(platform.progress()).dailyResults[d.day!];
      para(T("Seed: {seed} · {day} (UTC)", { seed: d.seed.toString(16), day: d.day! }), bw, "center", "daily-seed");
      para(done
        ? T(done.won ? "Played today: won {score}. You can replay, but the recorded result stands." : "Played today: lost {score}. You can replay, but the recorded result stands.", { score: done.score })
        : (platform.signedIn() ? T("One shared seed for everyone today. Your first result is recorded to your profile.") : T("One shared seed for everyone today. First result is ranked.")),
      bw, "center-dim", "daily-note");
      break;
    }
    case "journey": journeyGrid(bw, L); break;
    case "practice": {
      para(T("Unranked. Undo allowed. No effect on ratings or journey."), bw, "center-dim", "practice-desc");
      const cur = c?.aiDifficulty ?? 1;
      segRow("diff", Content.PRACTICE_DIFFICULTIES.map((d) => ({ id: `diff-${d.id}`, text: T(d.name), selected: d.id === cur, act: () => setDifficulty(d.id), quiet: true })), bw, "btn-seg");
      para(T(Content.PRACTICE_DIFFICULTIES[cur]!.blurb), bw, "center-dim", "diff-blurb");
      break;
    }
    case "challenge": {
      ui.column("challenges", () => {
        Content.CHALLENGES.forEach((ch, i) => button({
          id: `challenge-${i}`, text: `${T(ch.name)} — ${T(ch.blurb ?? "")}`, style: "btn-stage", width: bw, selected: c?.challenge?.id === ch.id, act: () => pickChallenge(ch), quiet: true,
        }));
      }, { spacing: 8, width: bw });
      break;
    }
    case "online": onlineBody(bw); break;
  }
  const row: Btn[] = [];
  if (app.setup !== "online") row.push({ id: "btn-start-match", text: T("Start Match"), act: startConfiguredMatch, disabled: !app.config, quiet: true });
  row.push({ id: "btn-back", text: T("Back"), act: () => { cancelOnline(); leaveToTitle(); }, quiet: true });
  flow("setup-row", row, bw);
}
function segRow(id: string, list: Btn[], wd: number, style: string): void {
  ui.row(`${id}-group`, () => flow(id, list.map((b) => ({ ...b, style })), wd), { width: wd, justify: "center" });
}
function journeyGrid(wd: number, L: Layout): void {
  const { done } = journeyState();
  const gap = 8, min = 140;
  const cols = Math.max(1, Math.floor((wd + gap) / (min + gap)));
  const cw = (wd - (cols - 1) * gap) / cols;
  const J = Content.JOURNEY;
  const picked = app.config?.stage?.id ?? null;
  const grid = (): void => {
    lastSize.set("stage-grid", ui.column("stage-grid", () => {
      for (let r = 0; r * cols < J.length; r++) {
        ui.row(`stage-r${r}`, () => {
          for (let i = r * cols; i < Math.min(J.length, (r + 1) * cols); i++) {
            const st = J[i]!;
            const isDone = done.has(st.id), locked = stageLocked(i, done);
            const name = stageName(st);
            button({ id: `stage-${i + 1}`, text: (isDone ? "✓ " : "") + name, name, style: isDone ? "btn-stage-done" : "btn-stage", width: cw,
              disabled: locked, selected: st.id === picked, act: () => pickStage(st as Stage), quiet: true });
          }
        }, { spacing: gap });
      }
    }, { spacing: gap, width: wd - 14 }));
  };
  const maxH = 0.45 * L.lh;
  ui.scrollArea("stage-scroll", { width: wd, height: Math.min(maxH, hOf("stage-grid", L, maxH) + 8) }, grid);
}
function onlineBody(wd: number): void {
  para(T("Online 1v1 shootout. Create a match and a friend can quick-join it, or jump straight into any open match."), wd, "center-dim", "online-desc");
  if (!app.lobby) {
    flow("online-row", [
      { id: "btn-create-online", text: T("Create online match"), act: () => createOnline(false), disabled: app.onlineBusy },
      { id: "btn-join-online", text: T("Quick join a match"), act: () => createOnline(true), disabled: app.onlineBusy },
    ], wd);
  } else {
    const n = app.lobby.participants.length;
    para(T("Players: {n}/2", { n }), wd, "center", "online-seats");
    button({ id: "btn-cancel-online", text: T("Cancel"), act: cancelOnline });
  }
  if (app.onlineStatus) para(app.onlineStatus(), wd, "center-dim", "online-status");
}

// ------------------------------------------------------------------ the play HUD (screen-play)
function hud(L: Layout): void {
  const st = currentState();
  const t = hudText();
  // status bar: mode, score, decision clock (pointer-transparent labels)
  ui.place("status", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.row("status-row", () => {
      ui.style("sb").id("sb-mode").label(t.mode || "Spot Kick");
      ui.spacer();
      ui.style("sb").id("sb-clock").label(clockText() || " ");
    }, { style: "status", width: L.lw, height: 32, align: "center", padding: { start: 12, end: 12 } });
  });
  ui.place("score", { anchor: "top", y: 6 }, () => {
    ui.style("sb-score").id("sb-score").label(st ? `${st.scoreA} – ${st.scoreB}${st.suddenDeath ? " " + T("(SD)") : ""}` : "0 – 0");
  });
  // HUD top: objective, phase, kick dots
  const tw = Math.min(L.lw - 24, 600);
  const topY = L.land ? 24 : 30;
  ui.place("hud-top", { anchor: "top", y: topY }, () => {
    lastSize.set("hud-top", ui.column("hud-top-col", () => {
      para(t.objective, tw, "objective", "hud-objective");
      para(t.phase, tw, "phase", "hud-phase");
      if (st && st.log.length) {
        ui.row("hud-kicks", () => {
          for (const rec of st.log) ui.style(rec.o === "goal" ? "kick-goal" : rec.o === "saved" ? "kick-saved" : "kick-off").widget("", { role: "none", size: { width: 14, height: 14 } });
        }, { spacing: 6, justify: "center" });
      }
    }, { spacing: 2, width: tw, align: "center" }));
  });
  const topBottom = Math.min(L.lh * 0.3, topY + hOf("hud-top", L, 60) + 4);
  // the tray and the actions
  const actions = actionList();
  const tray = app.panels;
  let vx = 0, vw = L.lw, vy = topBottom, vh = L.lh - topBottom;
  if (L.land) {
    const trayW = tray ? Math.min(L.lw * 0.45, wOf("tray", L, 230)) : 0;
    if (tray) ui.place("tray-p", { anchor: "bottom-start", x: 8, y: 8 }, () => { lastSize.set("tray", trayPanel(tray, L, 240)); });
    ui.place("actions-p", { anchor: "bottom-end", x: 8, y: 8 }, () => {
      lastSize.set("actions", ui.column("actions", () => { for (const b of actions) button(b); }, { spacing: 8 }));
    });
    const aw = Math.min(L.lw * 0.3, wOf("actions", L, 56) + 16);
    vx = tray ? Math.min(L.lw * 0.45, trayW + 16) : 0;
    vw = L.lw - vx - aw;
    vh = L.lh - topBottom;
  } else {
    const pw = Math.min(0.94 * L.lw, L.wide ? 520 : 420);
    ui.place("controls", { anchor: "bottom", y: 8 }, () => {
      lastSize.set("controls", ui.column("controls-col", () => {
        if (tray) trayPanel(tray, L, pw);
        ui.row("actions", () => { for (const b of actions) button(b); }, { spacing: 10, justify: "center" });
      }, { spacing: 10, align: "center" }));
    });
    const bottom = Math.min(L.lh * 0.55, hOf("controls", L, 200) + 8);
    vh = L.lh - topBottom - bottom;
    captions(L, bottom + 8);
  }
  if (L.land) captions(L, 12);
  Object.assign(view, toWindow(vx, vy, Math.max(1, vw), Math.max(1, vh)));
  if (myTurn() && !app.overlay) zoneTargets();
}
function actionList(): Btn[] {
  const list: Btn[] = [
    { id: "btn-pause", text: "❚❚", name: T("Pause"), style: "btn-hud", act: pause, quiet: true },
    { id: "btn-skip", text: "⏭", name: T("Skip animation"), style: "btn-hud", act: skipAnim, quiet: true },
  ];
  if (canUndo()) list.push({ id: "btn-undo", text: T("Undo"), style: "btn-hud", act: doUndo, quiet: true });
  list.push({ id: "btn-camera", text: "⌂", name: T("Reset camera"), style: "btn-hud", act: resetCamera, quiet: true });
  if (platform.options.leftHanded) list.reverse();
  return list.map((b) => ({ ...b, content: b.name ? () => { ui.style("face").label(b.text); } : undefined }));
}
const ZONES: { dir: string; height: string; glyph: string; name: string }[] = [
  { dir: "left", height: "high", glyph: "↖", name: "Left high" }, { dir: "center", height: "high", glyph: "↑", name: "Center high" },
  { dir: "right", height: "high", glyph: "↗", name: "Right high" }, { dir: "left", height: "low", glyph: "↙", name: "Left low" },
  { dir: "center", height: "low", glyph: "↓", name: "Center low" }, { dir: "right", height: "low", glyph: "↘", name: "Right low" },
];
/** #panel-shoot / #panel-dive / #panel-wait. */
function trayPanel(kind: "shoot" | "dive" | "wait", L: Layout, pw: number): ui.Rect {
  const small = L.land;
  if (kind === "wait") {
    return ui.column("panel-wait", () => para(app.waitText ? app.waitText() : T("Waiting…"), Math.min(pw, 360) - 32, "wait", "wait-text"),
      { style: small ? "tray-sm" : "tray", align: "center" });
  }
  const keeper = kind === "dive";
  const sel = selection();
  const grid = (): void => {
    ui.column(`${kind}-zones`, () => {
      for (const r of [0, 1]) ui.row(`${kind}-zr${r}`, () => {
        for (const z of ZONES.slice(r * 3, r * 3 + 3)) {
          const on = !!app.sel.zone && app.sel.zone.dir === z.dir && app.sel.zone.height === z.height;
          button({ id: `zone-${z.dir}-${z.height}`, text: z.glyph, name: T(z.name), style: "btn-zone", width: small ? 44 : 48, height: 44, selected: on,
            act: () => { ui.setFocus(null); pickZone({ dir: z.dir, height: z.height }); }, quiet: true,
            content: () => { ui.style("face-zone").label(z.glyph); } });
        }
      }, { spacing: small ? 4 : 6 });
    }, { spacing: small ? 4 : 6 });
  };
  const seg = (): void => {
    const segStyle = small ? "btn-seg-sm" : "btn-seg";
    const list: Btn[] = keeper
      ? [["early", T("Early")], ["on", T("On time")], ["late", T("Late")]].map(([v, l]) => ({ id: `timing-${v}`, text: l!, style: segStyle, selected: app.sel.timing === v, act: () => setTiming(v!), quiet: true }))
      : [["left", T("Curve ↰")], ["none", T("Straight")], ["right", T("Curve ↱")]].map(([v, l]) => ({ id: `curve-${v}`, text: l!, style: segStyle, selected: app.sel.curve === v, act: () => setCurve(v!), quiet: true }));
    ui.row(`${kind}-seg`, () => { for (const b of list) button(b); }, { spacing: small ? 4 : 8 });
  };
  const confirm = (): void => button({
    id: keeper ? "btn-confirm-dive" : "btn-confirm-shot", text: keeper ? T("Dive!") : T("Kick!"), style: small ? "btn-confirm-sm" : "btn-confirm",
    disabled: !sel.ok, act: () => { ui.setFocus(null); confirmSelection(); }, quiet: true,
  });
  const label = keeper ? T("Read the shot: pick a zone and dive timing.") : T("Aim: tap a goal zone (on the goal or below), choose curve, confirm.");
  const inner = pw - 32;
  if (small) {
    return ui.column(`panel-${kind}`, () => {
      grid(); seg();
      para(sel.text, 220, "sel-sm", `${kind}-selection`);
      confirm();
    }, { style: "tray-sm", spacing: 4, align: "center" });
  }
  if (L.wide) {
    return ui.column(`panel-${kind}`, () => {
      para(label, inner, "panel-label", `${kind}-label`);
      ui.row(`${kind}-body`, () => {
        grid();
        ui.column(`${kind}-right`, () => { seg(); para(sel.text, inner - 180, "sel", `${kind}-selection`); confirm(); }, { spacing: 6, align: "center" });
      }, { spacing: 14, align: "center" });
    }, { style: "tray", spacing: 6, align: "center", width: pw });
  }
  return ui.column(`panel-${kind}`, () => {
    para(label, inner, "panel-label", `${kind}-label`);
    grid(); seg();
    para(sel.text, inner, "sel", `${kind}-selection`);
    confirm();
  }, { style: "tray", spacing: 8, align: "center", width: pw });
}
/** The six goal zones as named targets over the goal (the 3D pick planes' DOM equivalent). */
function zoneTargets(): void {
  for (const z of ZONES) {
    const zone: Zone = { dir: z.dir, height: z.height };
    const r = render.zoneScreenRect(zone);
    if (r.width <= 0 || r.x + r.width < view.x || r.y + r.height < view.y || r.x > view.x + view.width || r.y > view.y + view.height) continue;
    ui.target(T("Goal zone {zone}", { zone: zoneName(zone) }), r, { role: "button" });
  }
}
function captions(L: Layout, bottom: number): void {
  const c = app.captions[app.captions.length - 1];
  if (!c) return;
  ui.place("captions", { anchor: "bottom", y: bottom }, () => {
    ui.column("caption-box", () => para(T(c.text), Math.min(L.lw - 60, 420), "caption-text", "caption-text"), { style: "caption" });
  });
}

// ------------------------------------------------------------------ results (screen-results)
const TERMINAL: Record<string, string> = { mathematical: "decided before the last kick", "decided-regular": "after regulation kicks", "decided-sudden-death": "in sudden death", forfeit: "a player left the match" };
function resultsPage(wd: number, L: Layout): void {
  const r = app.results;
  if (!r) return;
  const bw = Math.min(wd, 600);
  para(r.headline(), bw, "h2", "results-headline");
  const b = r.breakdown;
  ui.column("results-body", () => {
    const iw = bw - 36;
    if (b) {
      const c0 = Math.min(200, iw * 0.5), c1 = (iw - c0) / 2;
      const row = (id: string, cells: string[], cls: string): void => {
        ui.row(id, () => { cells.forEach((v, i) => ui.row(`${id}-${i}`, () => ui.style(cls).label(v), { width: i ? c1 : c0, justify: i ? "center" : "start" })); }, { width: iw });
      };
      row("res-h", [T("Component"), r.nameA(), r.nameB()], "th");
      const rows: [string, { A: number; B: number }][] = [
        ["Goals", b.goals], ["Saves", b.saves], ["Perfect kicks", b.perfectKicks], ["Off target", b.offTarget], ["Invalid actions", b.invalidActions], ["Kicks taken", b.kicks],
      ];
      rows.forEach(([k, v], i) => row(`res-${i}`, [T(k), String(v.A), String(v.B)], "td"));
      para(T("Ended: {reason}", { reason: T(TERMINAL[b.terminalReason ?? ""] ?? b.terminalReason ?? "") }) + (b.suddenDeath ? " · " + T("sudden death") : "") +
        (r.elapsedMs ? ` · ${Math.round(r.elapsedMs / 1000)}s` : ""), iw, "dim", "results-ended");
    }
    if (r.extra) para(r.extra(), iw, "dim", "results-extra");
    if (r.lb) para(r.lb(), iw, "text", "results-lb");
    if (r.board && r.board.length) {
      para(T("Platform board"), iw, "h3", "board-h");
      r.board.forEach((e, i) => para(`${e.rank}. ${e.name}${e.you ? " " + T("(you)") : ""} — ${e.score}`, iw, e.you ? "td-you" : "td", `board-${i}`));
    }
  }, { style: "results-box", spacing: 6, width: bw });
  if (r.achievements.length) {
    ui.column("results-ach", () => {
      for (const a of r.achievements) ui.row(`ach-${a.key}`, () => ui.style("ach-text").label(`🏆 ${T(a.name)}`), { style: "ach" });
    }, { spacing: 6, align: "center" });
  }
  para(r.next(), bw, "center-dim", "results-next");
  flow("results-row", [
    { id: "btn-replay", text: T("Replay"), act: replayMatch, quiet: true },
    { id: "btn-next", text: r.nextLabel ? r.nextLabel() : T("Next"), act: nextMatch, quiet: true },
    { id: "btn-menu", text: T("Menu"), act: leaveToTitle, quiet: true },
  ], bw);
  void L;
}

// ------------------------------------------------------------------ overlays (overlay-pause, overlay-help, overlay-expired)
function overlay(L: Layout): void {
  const o = app.overlay!;
  const label = o === "pause" ? T("Paused") : o === "settings" ? T("Settings") : o === "help" ? T("How to play") : (app.notice?.title() ?? "");
  page(label, "overlay-bg", L, (wd) => {
    if (o === "pause" || o === "settings") settingsPanel(wd, o === "pause");
    else if (o === "help") helpPanel(wd);
    else noticePanel(wd);
  }, () => { if (o === "help") closeHelp(); else if (o === "notice") closeOverlay(); else resume(); });
}
function settingsPanel(wd: number, paused: boolean): void {
  const bw = Math.min(wd, 560);
  para(paused ? T("Paused") : T("Settings"), bw, "h2", "pause-heading");
  button({ id: "btn-resume", text: paused ? T("Resume") : T("Back"), act: resume, width: Math.min(bw, 240), quiet: true });
  const o = platform.options;
  const section = (id: string, title: string, build: (iw: number) => void): void => {
    ui.column(id, () => { para(title, bw - 30, "legend", `${id}-h`); build(bw - 30); }, { style: "section", width: bw, spacing: 8 });
  };
  section("set-audio", T("Audio"), (iw) => {
    para(T("Volumes, mute, graphics quality, language, larger text, high contrast, reduced motion and vibration are in the StarHermit Options."), iw, "dim", "options-note");
    flow("set-runtime", [
      { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
    ], iw, 8, "start");
  });
  section("set-gfx", T("Graphics"), (iw) => {
    const themes = Content.THEMES;
    const idx = Math.max(0, themes.findIndex((t) => t.id === currentTheme().id));
    ui.row("set-theme-row", () => {
      para(T("Theme"), iw * 0.35, "text", "set-theme-label");
      ui.spacer();
      const pick = ui.id("set-theme").select(T("Theme"), idx, themes.map((t) => T(t.name)), { width: Math.min(iw * 0.62, 300) } as ui.WidgetOptions);
      if (pick !== idx) later(() => platform.setOption("theme", themes[pick]!.id));
    }, { width: iw, align: "center", height: 48 });
    if (ui.preferences().highContrast) para(T("High contrast (StarHermit Options) shows the Monochrome theme."), iw, "dim", "theme-hc");
  });
  section("set-a11y", T("Accessibility"), (iw) => {
    toggleRow("opt-left-handed", T("Left-handed controls"), o.leftHanded, iw, (v) => platform.setOption("leftHanded", v));
    toggleRow("opt-timing-assist", T("Timing assistance"), o.timingAssist, iw, (v) => platform.setOption("timingAssist", v));
    toggleRow("opt-captions", T("Captions"), o.captions, iw, (v) => platform.setOption("captions", v));
  });
  section("set-match", T("Match"), (iw) => {
    const list: Btn[] = [
      { id: "btn-howto", text: T("How to play"), act: showHelp, quiet: true },
      { id: "btn-replay-tutorial", text: T("Replay tutorial"), act: () => { closeOverlay(); app.paused = false; startLearn(); } },
    ];
    if (paused) list.push({ id: "btn-leave", text: T("Leave match"), act: leaveToTitle, quiet: true });
    flow("set-match-row", list, iw, 8, "start");
  });
}
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, wd: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, wd - 56, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : "#1a2942");
        draw.strokeRoundRect(bx, by, box, box, 4, token("edge"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#0b1220", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => { set(!on); sound("ui-confirm"); });
  }, { width: wd, align: "center", spacing: 8, height: 44 });
}
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/");
}
function helpPanel(wd: number): void {
  const bw = Math.min(wd, 600);
  para(T("How to play"), bw, "h2", "help-heading");
  const keys = [
    T("{keys}: move zone cursor", { keys: [keysFor("left"), keysFor("right"), keysFor("high"), keysFor("low")].join(" ") }),
    T("{keys}: select zone or confirm", { keys: keysFor("confirm") }),
    T("{keys}: curve", { keys: `${keysFor("curve_left")}/${keysFor("curve_right")}` }),
    T("{keys}: dive timing", { keys: `${keysFor("early")}/${keysFor("on_time")}/${keysFor("late")}` }),
    T("{keys}: pause", { keys: keysFor("pause") }), T("{keys}: undo (practice)", { keys: keysFor("undo") }),
    T("{keys}: help", { keys: keysFor("help") }), T("{keys}: reset camera", { keys: keysFor("camera") }), T("{keys}: skip animation", { keys: keysFor("skip") }),
  ];
  const cards: [string, string][] = [
    [T("Objective"), T("Alternate shooting and goalkeeping across a five-kick set. Score more than your opponent; ties go to sudden death, kick for kick.")],
    [T("Shooting"), T("Pick a goal zone (left / center / right, low / high) and a curve. Curve shifts the ball one column late — it beats early dives but can miss the frame.")],
    [T("Goalkeeping"), T("Pick a zone and a timing. On-time saves the exact zone. Early covers a whole column against straight shots but is beaten by curve. Late saves nothing.")],
    [T("Scoring"), T("Results break down goals, saves, perfect kicks, off-target and invalid actions. Ties resolve by goals, then fewer invalid actions, then elapsed time.")],
    [T("Keyboard"), keys.join(" · ")],
    [T("Touch"), T("Tap a goal zone to target it, then confirm. Drag gestures never required; every action is a single tap.")],
  ];
  ui.column("help-cards", () => {
    cards.forEach(([h, txt], i) => ui.column(`help-${i}`, () => { para(h, bw - 36, "h3", `help-${i}-h`); para(txt, bw - 36, "text", `help-${i}-p`); }, { style: "help-card", width: bw, spacing: 4 }));
  }, { spacing: 12, width: bw });
  button({ id: "btn-close-help", text: T("Close"), act: closeHelp, quiet: true });
}
function noticePanel(wd: number): void {
  const n = app.notice;
  const bw = Math.min(wd, 520);
  if (!n) return;
  para(n.title(), bw, "h2", "notice-heading");
  para(n.body(), bw, "center", "notice-body");
  const list: Btn[] = [];
  if (!platform.signedIn()) list.push({ id: "btn-notice-signin", text: S("signIn"), act: () => { closeOverlay(); signIn(); } });
  list.push({ id: "btn-notice-local", text: S("playLocal"), act: closeOverlay });
  flow("notice-row", list, bw);
}

// ------------------------------------------------------------------ toasts (.sh-toast)
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const wd = Math.min(L.lw - 32, 520);
  ui.place("toast-stack", { anchor: "bottom", y: 16 }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text(), wd - 34, "toast-text", `toast-${i}-text`), { style: "toast" }));
    }, { spacing: 6, align: "center" });
  });
}
