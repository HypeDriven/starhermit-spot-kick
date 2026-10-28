// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the crowd and the floodlight motes scaled within the tier by the level
// (frame().levelIndex, at most 1.5×, at most 2,000 supporters and 600 motes),
// as the browser build scaled them by its hardware level. The runtime owns the
// rest of what the old Graphics section did: Auto and the level choice, the
// render scale and pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout. The old per-effect overrides are not offered (the runtime's
// Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  bloom: boolean;
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

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, crowd: "sparse", atmosphere: false },
  balanced: { shadows: 1024, bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, crowd: "full", atmosphere: true },
  high: { shadows: 2048, bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, crowd: "full", atmosphere: true },
  ultra: { shadows: 4096, bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, crowd: "full", atmosphere: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", pitch: 128, ball: 256, seg: 0.5, crowd: 500, motes: 120, bloomRes: 0.5 },
  balanced: { material: "standard", pitch: 256, ball: 512, seg: 0.75, crowd: 900, motes: 180, bloomRes: 0.5 },
  high: { material: "physical", pitch: 256, ball: 512, seg: 1, crowd: 1100, motes: 260, bloomRes: 0.5 },
  ultra: { material: "physical", pitch: 512, ball: 1024, seg: 1.5, crowd: 1600, motes: 400, bloomRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const CROWD_MAX = 2000, CROWD_SPARSE = 220, MOTE_MAX = 600;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // levels are about 1.64× apart: counts grow with the level above the tier's first, at most 1.5× (gfx.js budgetFor)
  const k = Math.min(1.5, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.crowd = Math.min(CROWD_MAX, Math.round(b.crowd * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js crowdCount: supporters drawn for the look. */
export function crowdCount(l: Look): number { return l.crowd === "full" ? l.budget.crowd : Math.min(CROWD_SPARSE, l.budget.crowd); }
