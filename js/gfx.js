'use strict';

/*
 * Spot Kick graphics quality model — presets, per-category overrides, StarHermit
 * hardware-level detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js, no DOM) so the settings
 * panel, the renderer and unit tests agree on what a setting means.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickGfx = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  const CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],   // image-based lighting (environment map)
    detail: ['plain', 'detailed'], // pitch mowing/turf texture, ball panels, full net
    crowd: ['sparse', 'full'],     // instanced crowd size + supporter colours/bob
    atmosphere: ['off', 'on']      // floodlight beams, glow halos, drifting motes
  };

  // Each preset: a tier per category, a render scale (multiplies the capped
  // device pixel ratio) and the pixel-ratio cap.
  const TABLE = {
    low: { scale: 1, cap: 1, shadows: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', crowd: 'sparse', atmosphere: 'off' },
    balanced: { scale: 1, cap: 1.5, shadows: 'low', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', crowd: 'full', atmosphere: 'on' },
    high: { scale: 1, cap: 2, shadows: 'medium', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', crowd: 'full', atmosphere: 'on' },
    ultra: { scale: 1.25, cap: 2, shadows: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', crowd: 'full', atmosphere: 'on' }
  };

  const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
  // 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before this one): Low from 0,
  // Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
  const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  const gpuApi = () => (typeof globalThis !== 'undefined' ? globalThis.StarHermitGpu : undefined);

  /** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
  function detectLevel(gpu, system) {
    const G = gpuApi();
    const sys = Object.assign({ webgl: true, webgl2: true }, system || {}, { gpu: String(gpu || '') });
    if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
    return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
  }

  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    const G = gpuApi();
    return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter(p => LEVELS[p] <= level).pop() || 'low';
  }

  /** Best preset for this GPU (the hardware level already caps phones and tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /*
   * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
   * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). The goal, zones,
   * keeper, ball flight, picking and rules are identical on every preset — only visuals change.
   *   material  keeper, ball, posts, pitch and stand shading: lambert (Low) / standard (Balanced) /
   *             physical clear-coated posts, ball and gloves (High, Ultra)
   *   pitch     mowing-stripe turf texture size in px (Surface detail on)
   *   ball      panel-ball texture width in px (height ½; Surface detail on)
   *   seg       curved-mesh segment multiplier (ball, keeper, posts, floodlight beams, pitch arc)
   *   crowd     supporters at Crowd "full" (sparse: 220), scaled with the level
   *   motes     drifting floodlight motes (Atmosphere on), scaled with the level
   *   bloomRes  bloom resolution as a fraction of the frame
   */
  const BUDGETS = {
    low: { material: 'lambert', pitch: 128, ball: 256, seg: 0.5, crowd: 500, motes: 120, bloomRes: 0.5 },
    balanced: { material: 'standard', pitch: 256, ball: 512, seg: 0.75, crowd: 900, motes: 180, bloomRes: 0.5 },
    high: { material: 'physical', pitch: 256, ball: 512, seg: 1, crowd: 1100, motes: 260, bloomRes: 0.5 },
    ultra: { material: 'physical', pitch: 512, ball: 1024, seg: 1.5, crowd: 1600, motes: 400, bloomRes: 1 }
  };
  const CROWD_MAX = 2000, CROWD_SPARSE = 220, MOTE_MAX = 600;

  /** A preset's concrete budget for a hardware level (crowd and motes scale ≤ 1.5× within the preset). */
  function budgetFor(preset, level) {
    const b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    const G = gpuApi(), floor = LEVELS[preset] || 0;
    const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
    const k = G ? Math.min(1.5, G.scaleBudget(1, lv, floor)) : 1;
    b.crowd = Math.min(CROWD_MAX, Math.round(b.crowd * k));
    b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
    return b;
  }

  /** Supporters drawn for a resolved setting (Crowd tier × the preset's budget). */
  function crowdCount(r) { return r.crowd === 'full' ? r.budget.crowd : Math.min(CROWD_SPARSE, r.budget.crowd); }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale (0.5–2), adaptive, show_fps, <category>: 'preset'|tier }
   */
  function resolve(saved, detected, level) {
    const s = saved || {};
    const auto = PRESETS.indexOf(s.preset) < 0;
    const preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    const row = TABLE[preset];
    const out = {
      preset: preset, auto: auto, cap: row.cap,
      renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2)
    };
    out.scale = row.scale * out.renderScale;
    for (const cat of Object.keys(CATEGORIES)) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    }
    out.level = Number.isFinite(level) ? level : LEVELS[preset];
    out.budget = budgetFor(preset, out.level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // The composer runs only when an effect needs it; otherwise direct render.
    out.post = out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** New saved object for a preset choice: clears every per-category override. */
  function choosePreset(saved, preset) {
    const s = saved || {};
    return {
      preset: PRESETS.indexOf(preset) >= 0 ? preset : 'auto',
      render_scale: s.render_scale != null ? s.render_scale : 1,
      adaptive: s.adaptive !== false,
      show_fps: !!s.show_fps
    };
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    const row = TABLE[preset];
    return row ? row[cat] : undefined;
  }

  /** Short cost summary. */
  function describe(r, pixels) {
    const parts = [
      r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
      r.bloom === 'on' ? 'bloom' : null,
      r.reflections === 'on' ? 'reflections' : null,
      r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  /** Adaptive resolution step from an average frame time (ms). */
  function adaptStep(scale, avgMs) {
    if (avgMs > 26) return Math.max(0.6, Math.round((scale - 0.1) * 100) / 100);
    if (avgMs < 14 && scale < 1) return Math.min(1, Math.round((scale + 0.05) * 100) / 100);
    return scale;
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    LEVELS: LEVELS, BUDGETS: BUDGETS, CROWD_MAX: CROWD_MAX, CROWD_SPARSE: CROWD_SPARSE, MOTE_MAX: MOTE_MAX,
    detectLevel: detectLevel, presetForLevel: presetForLevel, budgetFor: budgetFor, crowdCount: crowdCount,
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe, adaptStep: adaptStep
  };
});
