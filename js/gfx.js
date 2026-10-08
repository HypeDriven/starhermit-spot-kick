'use strict';

/*
 * Spot Kick graphics quality model — presets, per-category overrides, GPU
 * detection and a cost summary. Pure (no three.js, no DOM) so the settings
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

  /** Best preset for this GPU (unmasked renderer string). Touch devices cap at balanced. */
  function detectPreset(gpu, opts) {
    const g = String(gpu || '').toLowerCase();
    let p;
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
    else p = 'balanced';
    if (opts && opts.mobile && p === 'high') p = 'balanced';
    return p;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale (0.5–2), adaptive, show_fps, <category>: 'preset'|tier }
   */
  function resolve(saved, detected) {
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
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe, adaptStep: adaptStep
  };
});
