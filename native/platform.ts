// The game's data and the StarHermit platform, on the runtime's modules (what
// js/platform.js and js/ui.js's persistence did over the JS SDK and
// localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the progression document (js/progress.js); two
//   devices' saves merge on a conflict (mergeSaves, as the browser build did
//   on its saveconflict); the slot the browser build wrote through the JS SDK
//   (game:<slug>, the checksummed session.encodeSave text) shows as foreign:
//   it is merged in and replaced once;
// - the game's own options (stadium theme, timing assistance, left-handed
//   tray, captions) are engine `settings` (synced with the account); the
//   browser build's values in the account's settings KV are adopted (unless
//   set here since) and the finished tutorial joins the save, then all its KV
//   keys are removed (volumes, graphics, reduced motion, high contrast,
//   larger text, haptics and the language are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished match's goals through server.js's score path (a practice session
//   whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank, and the board's top entries;
// - rooms and the bound session's game socket for js/online.js (`adapter`).
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, rooms, serverNow, serverTime, sessions,
  type GameSocket, type Leaderboard, type Room, type RoomSocket,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Progress, type Options, type Save } from "./classic.ts";

// --- the save --------------------------------------------------------------------------------
let data: Save = Progress.normalize(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The live progression (change it, then persist()). */
export function progress(): Save { return data; }
/** Saves (the device at once, the account debounced by the runtime). */
export function persist(): void { write(); }
function adopt(other: unknown): boolean {
  const next = Progress.mergeSaves(other, data);
  if (Progress.same(next, data)) return false;
  data = next;
  write();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Progress.mergeSaves(remote.data, mine?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud progression: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = old.text != null ? Progress.readForeign(old.text) : null;
  let grew = false;
  if (doc) {
    const next = Progress.mergeSaves(doc, data);
    grew = !Progress.same(next, data);
    data = next;
  }
  write({ replaceForeign: true });
  if (grew) merged();
}
/** The sync line: local for a guest, else connecting / saving / synced / error. */
export function syncState(): "local" | "connecting" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading") return "connecting";
  if (st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options -----------------------------------------------------------------------
export const options: Options = { ...Progress.DEFAULT_OPTIONS };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Progress.pickOption(key, v);
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
function adoptOption(key: keyof Options, value: unknown): void {
  const v = Progress.pickOption(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
/** The browser build's settings KV: the options carry over (unless set here since), then all its keys go. */
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const key of keys) kv[key] = store.legacy(key);
  const old = Progress.readLegacySettings(kv);
  for (const [k, v] of Object.entries(old.options)) adoptOption(k as keyof Options, v);
  if (old.tutorialDone && !data.tutorialDone) { data.tutorialDone = true; write(); }
  for (const key of keys) if (Progress.BROWSER_KEYS.includes(key) || key.startsWith("ui.")) { try { store.removeLegacy(key); } catch { /* kept */ } }
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = Progress.normalize(cur?.data ?? null);
  for (const k of Progress.OPTION_KEYS) readOption(k);
  store.onChange((key) => {
    if (!(Progress.OPTION_KEYS as string[]).includes(key)) return;
    readOption(key as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });
/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the goals board --------------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function goalsBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "goals") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { rank: number; name: string; score: number; you: boolean }
/** The board's top entries (the Daily's results), null when unavailable. */
export async function topEntries(n: number): Promise<BoardRow[] | null> {
  if (!player()) return null;
  try {
    const b = await goalsBoard();
    if (!b) return null;
    const me = userId();
    const r = await leaderboards.entries(b.id, { pageSize: n });
    const rows = r.items.slice(0, n).map((e) => ({ rank: e.rank, name: e.displayName || e.username || "", score: e.score, you: e.userId === me }));
    return rows.length ? rows : null;
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished match's goals through server.js; { posted, rank }. Never rejects. */
export async function postGoals(goals: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(goals));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { goals: score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("goals")) return { posted: false, rank: null };
  try {
    const b = await goalsBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

// --- rooms and the game socket (js/online.js's platform) ------------------------------------
interface RoomHandlers { onOpen?: () => void; onDown?: () => void; onRoster?: (room: Room) => void; onStopped?: (reason: string) => void }
interface GameHandlers {
  onOpen?: () => void; onDown?: () => void; onMessage?: (data: unknown) => void; onError?: (message: string) => void; onStopped?: (reason: string) => void;
}
export const adapter = {
  get userId(): string | null { return userId(); },
  createRoom: (cfg: { teamCount: number; seatsPerTeam: number; backfillAiPlayers: boolean; metadata: JsonValue }): Promise<Room> =>
    rooms.create({ ...cfg, isVisible: true }),
  openRoom: (id: string): Promise<Room> => rooms.open(id),
  startRoom: (id: string): Promise<Room> => rooms.start(id),
  leaveRoom: (id: string): Promise<void> => rooms.leave(id),
  getRoom: (id: string): Promise<Room | null> => rooms.get(id),
  quickJoin: (): Promise<Room | null> => rooms.quickJoin({ teamCount: 1, seatsPerTeam: 2 }),
  myRoom: (): Promise<Room | null> => rooms.mine(),
  connectRoom(roomId: string, h: RoomHandlers): { close(): void } {
    let socket: RoomSocket | null = null;
    try { socket = rooms.connect(roomId); } catch { queueMicrotask(() => h.onStopped?.("connect")); }
    if (socket) {
      socket.on("open", () => h.onOpen?.());
      socket.on("disconnected", () => h.onDown?.());
      socket.on("roster", (room) => h.onRoster?.(room));
      socket.on("stopped", (reason) => h.onStopped?.(reason));
    }
    return { close(): void { try { socket?.close(); } catch { /* gone */ } socket = null; } };
  },
  connectGame(sessionId: string, h: GameHandlers): { send(data: JsonValue): boolean; close(): void } {
    let socket: GameSocket | null = null;
    try { socket = connectGame(sessionId); } catch { queueMicrotask(() => h.onStopped?.("connect")); }
    if (socket) {
      socket.on("open", () => h.onOpen?.());
      socket.on("disconnected", () => h.onDown?.());
      socket.on("game", (d) => h.onMessage?.(d));
      socket.on("error", (message) => h.onError?.(message));
      socket.on("stopped", (reason) => h.onStopped?.(reason));
      socket.on("abandoned", (reason) => h.onStopped?.(`abandoned:${reason}`));
    }
    return {
      send(d: JsonValue): boolean { try { return !!socket && socket.state === "open" && socket.sendCommand(d); } catch { return false; } },
      close(): void { try { socket?.close(); } catch { /* gone */ } socket = null; },
    };
  },
};
/** The room the player holds a seat in (a relaunch restores its lobby or match), or null. */
export async function myRoom(): Promise<Room | null> {
  if (!signedIn()) return null;
  try { const r = await rooms.mine(); return r && r.status !== "closed" ? r : null; } catch { return null; }
}
