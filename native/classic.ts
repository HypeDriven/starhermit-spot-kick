// The browser build's pure scripts, shared with the node tests and server.js,
// evaluated as classic scripts (their globals are SpotKick*): the rules
// (js/rules.js: legal actions, deterministic resolution, the seeded streams,
// the AI, hashes and replays), the content (js/content.js: themes, the
// lessons, the 40 Journey stages, the challenges, the Daily, the practice
// keepers), the session (js/session.js: validated commands with ids, the AI
// turns, undo, the replay envelope, the checksummed save encoding), the save
// model and the game's options (js/progress.js), the string tables
// (js/strings.js) and the account strings (js/sh-strings.js).
import { loadClassic } from "starhermit:script";

for (const f of ["js/rules.js", "js/content.js", "js/session.js", "js/progress.js", "js/strings.js", "js/sh-strings.js"]) loadClassic(f);

export interface Zone { dir: string; height: string }
export interface Shot { dir: string; height: string; curve: string }
export interface Dive { dir: string; height: string; timing: string }
export interface KickEvent { type: "kick-resolved"; outcome: "goal" | "saved" | "offtarget"; shooter: "A" | "B"; shot: Shot; dive: Dive; finalCol: string }
export interface GameEvent { type: string; [k: string]: unknown }
export interface Constraints { bannedCurves: string[]; bannedHeights: string[]; bannedColumns: string[]; timeLimitMs: number }
export interface LogRec { k: number; s: "A" | "B"; o: string; sh: string[]; dv: string[] }
export interface State {
  version: number; seed: number; rounds: number; constraints: Constraints; tick: number; phase: "keeper" | "shooter" | "over";
  shooter: "A" | "B"; pendingDive: Dive | null; scoreA: number; scoreB: number; kicksA: number; kicksB: number;
  savesA: number; savesB: number; offTargetA: number; offTargetB: number; perfectA: number; perfectB: number;
  suddenDeath: boolean; sdRound: number; over: boolean; winner: "A" | "B" | null; terminalReason: string | null;
  invalidA: number; invalidB: number; log: LogRec[];
}
export interface Breakdown {
  goals: { A: number; B: number }; saves: { A: number; B: number }; perfectKicks: { A: number; B: number }; offTarget: { A: number; B: number };
  invalidActions: { A: number; B: number }; kicks: { A: number; B: number }; suddenDeath: boolean; winner: string | null; terminalReason: string | null;
}
export interface Applied { ok: boolean; reason?: string; state?: State; events?: GameEvent[]; countedInvalid?: boolean; duplicate?: boolean }
export interface Theme { id: string; name: string; sky: number; pitch: number; line: number; accent: number; ambient: string }
export interface Stage {
  id: string; index?: number; name: string; seed: number; rounds: number; aiDifficulty: number; goal: string; constraints: Constraints;
  theme: string; blurb?: string; day?: string; excluded?: boolean;
}
export interface Session {
  id: string; mode: string; state: State; ai: { side: "A" | "B"; difficulty: number } | null; undoStack: State[];
  envelope: { result: { elapsedMs: number; breakdown: Breakdown } | null }; startedAt: number; endedAt: number;
}
export interface Save {
  journeyDone: string[]; achievements: Record<string, number>; dailyResults: Record<string, { won: boolean; score: string; hash: string }>;
  streak: number; bestStreak: number; stats: { goals: number; saves: number; curvedGoals: number; wins: number; matches: number; dailies: number };
  tutorialDone?: boolean;
}
export interface Options { theme: string; timingAssist: boolean; leftHanded: boolean; captions: boolean }
export interface Achievement { key: string; name: string; desc: string }

interface RulesApi {
  COLUMNS: string[]; HEIGHTS: string[]; CURVES: string[]; TIMINGS: string[];
  legalActions(s: State): { type: string; player: string; params: Record<string, string> }[];
  isLegalShot(s: State, p: Shot): { ok: boolean; reason?: string };
  keeperSide(s: State): "A" | "B";
  breakdown(s: State): Breakdown;
  hashState(s: unknown): string;
  mixSeed(seed: number, salt: string): number;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; TUTORIAL_STEPS: { id: string; title: string; body: string; require: string }[];
  JOURNEY: Stage[]; CHALLENGES: Stage[]; PRACTICE_DIFFICULTIES: { id: number; name: string; blurb: string }[];
  dailyFor(day: string): Stage; utcDay(d?: Date): string; validateContent(): { ok: boolean; errors: string[] };
}
interface SessionApi {
  createSession(o: { seed: number; rounds: number; constraints?: Constraints | null; build?: string; contentVersion?: number; mode: string; ai: { side: "A" | "B"; difficulty: number } | null; id?: string }): Session;
  begin(s: Session, now: number): void;
  submit(s: Session, type: string, player: string, params: Record<string, string>): Applied;
  aiAct(s: Session): Applied[];
  undo(s: Session): { ok: boolean; reason?: string };
  verifyReplay(s: Session): { ok: boolean; reason?: string };
}
interface ProgressApi {
  SAVE_DEFAULTS: Save; ACHIEVEMENTS: Achievement[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[];
  normalize(raw: unknown): Save; mergeSaves(remote: unknown, local: unknown): Save; same(a: unknown, b: unknown): boolean;
  readForeign(text: string | null): Save | null; pickOption(key: string, v: unknown): unknown; unlock(save: Save, key: string, now: number): Achievement | null;
  readLegacySettings(kv: Record<string, unknown>): { options: Partial<Options>; tutorialDone: boolean };
}
export interface AccountStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string; expiredTitle: string; expiredBody: string;
  relaunch: string; playLocal: string; termsTitle: string; termsBody: string; lbPosting: string; lbRank: string; lbPosted: string; lbFailed: string;
}

const G = globalThis as unknown as {
  SpotKickRules: RulesApi; SpotKickContent: ContentApi; SpotKickSession: SessionApi; SpotKickProgress: ProgressApi;
  SK_STRINGS: Record<string, Record<string, string>>; SpotKickShStrings: { STRINGS: Record<string, AccountStrings> };
};
export const Rules = G.SpotKickRules;
export const Content = G.SpotKickContent;
export const SessionMod = G.SpotKickSession;
export const Progress = G.SpotKickProgress;
export const Strings = G.SK_STRINGS;
export const ShStrings = G.SpotKickShStrings;
