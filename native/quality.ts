// The look per graphics level. Engine-owned effects (shadows and their map
// size, bloom and its resolution, the grade, anti-aliasing) come from the
// level (levelSettings()); the browser build's art columns (js/gfx.js TABLE /
// BUDGETS: shading, turf, ball, segments, reflections, fine net, crowd, motes)
// stay keyed by the runtime's quality tier (frame().quality), with the crowd
// and the floodlight motes scaled within the tier by the level's particle
// budget (at most 1.5×, at most 2,000 supporters and 600 motes). The runtime
// owns the rest of what the old Graphics section did: Auto and the level
// choice, the render scale and pixel-ratio cap, adaptive resolution, the
// frame-rate limit and readout. The old per-effect overrides are not offered
// (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";
export interface Budget {
  /** Shading: Lambert (Low), Standard (Balanced), Physical clear-coated posts, ball and gloves (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Pitch turf texture size (Surface detail on). */
  pitch: number;
  /** Ball panel texture width (height ½). */
  ball: number;
  /** Curved-mesh segment multiplier. */
  seg: number;
  /** Supporters at Crowd full (sparse: 220). */
  crowd: number;
  /** Floodlight motes (Atmosphere on). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Pitch mowing/turf texture, ball panels, fine net. */
  detailed: boolean;
  crowd: "sparse" | "full";
  /** Floodlight beams, glow halos, drifting motes. */
  atmosphere: boolean;
  budget: Budget;
}

/** gfx.js TABLE's art columns. */
const ART: Record<QualityTier, Omit<Look, "preset" | "budget" | "shadows" | "bloom" | "grade" | "antialias">> = {
  low: { reflections: false, detailed: false, crowd: "sparse", atmosphere: false },
  balanced: { reflections: true, detailed: true, crowd: "full", atmosphere: true },
  high: { reflections: true, detailed: true, crowd: "full", atmosphere: true },
  ultra: { reflections: true, detailed: true, crowd: "full", atmosphere: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", pitch: 128, ball: 256, seg: 0.5, crowd: 500, motes: 120 },
  balanced: { material: "standard", pitch: 256, ball: 512, seg: 0.75, crowd: 900, motes: 180 },
  high: { material: "physical", pitch: 256, ball: 512, seg: 1, crowd: 1100, motes: 260 },
  ultra: { material: "physical", pitch: 512, ball: 1024, seg: 1.5, crowd: 1600, motes: 400 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const CROWD_MAX = 2000, CROWD_SPARSE = 220, MOTE_MAX = 600;

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // counts grow with the level's particle budget above the tier's anchor, at most 1.5× (gfx.js budgetFor)
  const k = Math.min(1.5, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.crowd = Math.min(CROWD_MAX, Math.round(b.crowd * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.pitch = Math.min(b.pitch, s.maxTextureSize);
  b.ball = Math.min(b.ball, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js crowdCount: supporters drawn for the look. */
export function crowdCount(l: Look): number { return l.crowd === "full" ? l.budget.crowd : Math.min(CROWD_SPARSE, l.budget.crowd); }
