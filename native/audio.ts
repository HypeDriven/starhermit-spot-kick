// Sound, as the browser build's js/audio.js: every logical event plays its
// authored one-shot (sfx/<event>.opus, sfx/manifest.json) on the effects bus
// (the menu clicks on the interface bus); the quiet night ambience (filtered
// brown noise) and the slow two-chord night pad (sine blips every 1.9 s, a
// triangle octave every fourth) from the first press on. The browser build ran
// both live (a noise loop and a timer scheduler); here they are rendered once
// into loops (createClip, a slice a frame on a sine table) and played on the
// music bus: the runtime has no ambience bus, so the noise's gain folds in the
// old ambience slider's 50 % default against music's 60 %. Sudden death lifts
// the pad by 1.35 (audio.js setTension). The oscillator transients audio.js
// synthesized while a sample decoded are not ported (a live synthesis graph
// makes clip loads fail on the engine's web runtime), so a clip still loading
// is silent. The runtime's Options own the volumes, the mute and the voice
// limit. Clips load once the mixer runs (natively at once, in a browser after
// the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Sfx = "ui-confirm" | "ui-back" | "ui-focus" | "invalid" | "dive-committed" | "kick" | "goal" | "save" | "offtarget"
  | "whistle-start" | "whistle-end" | "win" | "lose" | "achievement" | "tick";
/** audio.js captionFor: English keys, shown as captions. */
export const CAPTIONS: Record<Sfx, string> = {
  "ui-confirm": "Confirmed", "ui-back": "Back", "ui-focus": "", invalid: "Invalid action", "dive-committed": "Dive committed",
  kick: "Kick struck", goal: "Goal! Crowd roars", save: "Saved! Gloved away", offtarget: "Off target — crowd groans",
  "whistle-start": "Whistle: kickoff", "whistle-end": "Whistle: full time", win: "Victory — stadium erupts", lose: "Defeat — quiet crowd",
  achievement: "Achievement unlocked", tick: "Timer tick",
};
const UI_SFX = new Set<Sfx>(["ui-confirm", "ui-back", "ui-focus"]);
const names = new Set<string>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;

export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string }[];
    for (const it of list) if (it && typeof it.name === "string") names.add(it.name);
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  // the most used first
  const order = ["ui-confirm", "kick", "goal", "save", "offtarget", "dive-committed", "whistle-start", "tick"];
  for (const n of order) if (names.has(n)) queue.push(n);
  wantClips = true;
}

export function play(ev: Sfx): void {
  const clip = clips.get(ev);
  if (!clip) return;
  try { playClip(clip, { bus: UI_SFX.has(ev) ? "interface" : "effects" }); }
  catch { clips.delete(ev); if (!queue.includes(ev)) queue.push(ev); } // a clip the mixer lost: load it again
}

// -- the pad and the ambience -------------------------------------------------------------------
const RATE = 22050;
const TABLE_N = 4096;
const SINE = new Float32Array(TABLE_N);
for (let i = 0; i < TABLE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE_N);
const sine = (phase: number): number => SINE[Math.floor((phase - Math.floor(phase)) * TABLE_N) & (TABLE_N - 1)]!;
const tri = (phase: number): number => { const p = phase - Math.floor(phase); return p < 0.5 ? 4 * p - 1 : 3 - 4 * p; };
const ROOTS = [110, 130.81, 98, 146.83];
const STEP = 1.9;
// four bars of four roots: the octave triangle falls on every fourth step (musicStep % 4 === 0 after the increment)
const BEATS = 16;
const MUSIC_N = Math.round(RATE * STEP * BEATS);
const music = new Float32Array(MUSIC_N);
interface Voice { f: number; dur: number; gain: number; wave: "sine" | "triangle" }
let beat = 0, beatSample = 0;
function voices(b: number): Voice[] {
  const root = ROOTS[b % ROOTS.length]!;
  const out: Voice[] = [{ f: root, dur: 1.8, gain: 0.08, wave: "sine" }, { f: root * 1.5, dur: 1.8, gain: 0.05, wave: "sine" }];
  if ((b + 1) % 4 === 0) out.push({ f: root * 2, dur: 1.2, gain: 0.04, wave: "triangle" });
  return out;
}
/** One slice of the pad (audio.js blip: exponential from gain to 0.0001 over dur). */
function renderMusic(count: number): boolean {
  const LEN = Math.round(1.82 * RATE);
  while (count > 0 && beat < BEATS) {
    const s0 = Math.round(beat * STEP * RATE);
    const end = Math.min(LEN, beatSample + count);
    for (const v of voices(beat)) {
      const n = Math.round(v.dur * RATE);
      for (let i = beatSample; i < Math.min(end, n); i++) {
        const t = i / RATE;
        const env = v.gain * Math.pow(0.0001 / v.gain, t / v.dur);
        const k = (s0 + i) % MUSIC_N;
        music[k] = music[k]! + (v.wave === "sine" ? sine(v.f * t) : tri(v.f * t)) * env;
      }
    }
    count -= end - beatSample;
    beatSample = end;
    if (beatSample >= LEN) { beat++; beatSample = 0; }
  }
  return beat >= BEATS;
}
const AMB_N = RATE * 4;
const amb = new Float32Array(AMB_N);
let ambPos = 0, last = 0, lp = 0;
let seed = 0x2545f491;
const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
/** audio.js startAmbience: brown-ish noise × 3 through a 320 Hz low-pass at 0.5. */
function renderAmbience(count: number): boolean {
  const end = Math.min(AMB_N, ambPos + count);
  const a = 1 - Math.exp((-2 * Math.PI * 320) / RATE);
  for (let i = ambPos; i < end; i++) {
    last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02;
    lp += a * (last * 3 - lp);
    amb[i] = lp * 0.5;
  }
  ambPos = end;
  return ambPos >= AMB_N;
}
let musicClip: AudioClip | null = null, ambClip: AudioClip | null = null;
let musicVoice: Sound | null = null, ambVoice: Sound | null = null;
let rendered = false;
let tension = false;
const AMB_GAIN = 0.5 / 0.6;
const SLICE = 6000;
export function setTension(on: boolean): void {
  if (on === tension) return;
  tension = on;
  try { musicVoice?.fade(on ? 1.35 : 1, 0.4); } catch { /* gone */ }
}

/** Each frame: the clips once the mixer runs (one at a time), the loops rendered a slice a frame, then started. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of names) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!rendered) {
    if (!musicClip) {
      if (!renderMusic(SLICE)) return;
      try { musicClip = createClip([music], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); rendered = true; }
      return;
    }
    if (!ambClip) {
      if (!renderAmbience(SLICE)) return;
      try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
      rendered = true;
      return;
    }
  }
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true, gain: tension ? 1.35 : 1 }); } catch { musicVoice = null; }
    return;
  }
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
}
