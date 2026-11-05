// Sound, as the browser build's js/audio.js: every logical event plays its
// authored one-shot (sfx/<event>.opus, sfx/manifest.json) on the effects bus
// (the menu clicks on the interface bus); the quiet night ambience (filtered
// brown noise) and the slow two-chord night pad (sine blips every 1.9 s, a
// triangle octave every fourth) from the first press on. The browser build ran
// both live (a noise loop and a timer scheduler); here they are rendered once
// into loops (OfflineAudioContext) and played on the music bus: the runtime has
// no ambience bus, so the noise's gain folds in the old ambience slider's 50 %
// default against music's 60 %. Sudden death lifts the pad by 1.35 (audio.js
// setTension). The oscillator transients audio.js synthesized while a sample
// decoded are not ported, so a clip still loading is silent. The runtime's
// Options own the volumes, the mute and the voice limit. Every clip loads at
// start; the beds start once the mixer runs (in a browser, after the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
const clips = new Map<string, AudioClip>();

/** Loads every clip and renders the beds at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string }[];
    for (const it of list) {
      if (!it || typeof it.name !== "string") continue;
      const name = it.name;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  renderMusic().then((c) => { musicClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
  renderAmbience().then((c) => { ambClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}

export function play(ev: Sfx): void {
  const clip = clips.get(ev);
  if (!clip) return;
  try { playClip(clip, { bus: UI_SFX.has(ev) ? "interface" : "effects" }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- the pad and the ambience -------------------------------------------------------------------
const RATE = 22050;
const ROOTS = [110, 130.81, 98, 146.83];
const STEP = 1.9;
/** The four roots (a loop of 7.6 s): sine blips on the root and its fifth, a triangle octave on every fourth (audio.js blip: exponential from gain to 0.0001 over dur). */
async function renderMusic(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * STEP * ROOTS.length), RATE);
  const blip = (at: number, f: number, dur: number, gain: number, type: "sine" | "triangle"): void => {
    const osc = off.createOscillator(); osc.type = type; osc.frequency.value = f;
    const g = off.createGain();
    g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(off.destination); osc.start(at); osc.stop(at + dur);
  };
  ROOTS.forEach((root, b) => {
    const at = Math.round(b * STEP * RATE) / RATE;
    blip(at, root, 1.8, 0.08, "sine");
    blip(at, root * 1.5, 1.8, 0.05, "sine");
    if ((b + 1) % 4 === 0) blip(at, root * 2, 1.2, 0.04, "triangle");
  });
  return createClip(await off.startRendering());
}
/** audio.js startAmbience: brown noise through a 320 Hz low-pass, a 4 s loop (periodic once the filter settled). */
async function renderAmbience(): Promise<AudioClip> {
  const n = RATE * 4, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 0x2545f491, seconds: 4 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 320;
  const g = off.createGain(); g.gain.value = AMB_LEVEL;
  noise.connect(lp).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
let musicClip: AudioClip | null = null, ambClip: AudioClip | null = null;
let musicVoice: Sound | null = null, ambVoice: Sound | null = null;
let tension = false;
const AMB_GAIN = 0.5 / 0.6;
const AMB_LEVEL = 0.39; // the old bed's level: rms .0795 (engine brown noise is louder than audio.js's)
export function setTension(on: boolean): void {
  if (on === tension) return;
  tension = on;
  try { musicVoice?.fade(on ? 1.35 : 1, 0.4); } catch { /* gone */ }
}

/** Each frame: the beds start once the mixer runs and their renders are in. */
export function update(): void {
  if (context.state !== "running") return;
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true, gain: tension ? 1.35 : 1 }); } catch { musicVoice = null; }
    return;
  }
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
}
