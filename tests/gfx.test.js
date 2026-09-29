'use strict';

const gfx = require('../js/gfx');
const panel = require('../js/gfxpanel');

describe('gfx quality model', () => {
  test('detectPreset maps GPU strings to tiers', () => {
    expect(gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe('low');
    expect(gfx.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)')).toBe('high');
    expect(gfx.detectPreset('Apple M2')).toBe('high');
    expect(gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)')).toBe('balanced');
    expect(gfx.detectPreset('Adreno (TM) 650')).toBe('balanced');
    expect(gfx.detectPreset('')).toBe('balanced');
    // touch/mobile devices cap Auto at balanced
    expect(gfx.detectPreset('Apple M2', { mobile: true })).toBe('balanced');
    expect(gfx.detectPreset('SwiftShader', { mobile: true })).toBe('low');
  });

  test('resolve: auto follows the detected preset', () => {
    const r = gfx.resolve({}, 'low');
    expect(r.preset).toBe('low');
    expect(r.auto).toBe(true);
    expect(r.shadows).toBe('off');
    expect(r.post).toBe(false); // Low renders directly, no composer
    expect(r.adaptive).toBe(true);
    expect(r.showFps).toBe(false);
    expect(gfx.resolve({ preset: 'auto' }, 'high').preset).toBe('high');
    expect(gfx.resolve({}, undefined).preset).toBe('balanced');
  });

  test('resolve: explicit preset, overrides and invalid values', () => {
    const r = gfx.resolve({ preset: 'high', bloom: 'off', shadows: 'bogus' }, 'low');
    expect(r.preset).toBe('high');
    expect(r.auto).toBe(false);
    expect(r.bloom).toBe('off');                                    // override wins
    expect(r.shadows).toBe(gfx.presetTier('high', 'shadows'));      // invalid override ignored
    expect(r.post).toBe(true);
    for (const cat of Object.keys(gfx.CATEGORIES)) expect(gfx.CATEGORIES[cat]).toContain(r[cat]);
  });

  test('resolve: render scale clamps to 50–200% and multiplies the preset scale', () => {
    expect(gfx.resolve({ preset: 'high', render_scale: 5 }, 'low').renderScale).toBe(2);
    expect(gfx.resolve({ preset: 'high', render_scale: 0.1 }, 'low').renderScale).toBe(0.5);
    expect(gfx.resolve({ preset: 'ultra', render_scale: 0.8 }, 'low').scale).toBeCloseTo(1.0);
    expect(gfx.resolve({ preset: 'low' }, 'low').cap).toBe(1);
    expect(gfx.resolve({ preset: 'balanced' }, 'low').cap).toBe(1.5);
    expect(gfx.resolve({ preset: 'ultra' }, 'low').cap).toBe(2);
  });

  test('choosing a preset clears per-category overrides but keeps scale/toggles', () => {
    const saved = { preset: 'high', bloom: 'off', shadows: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
    const next = gfx.choosePreset(saved, 'low');
    expect(next).toEqual({ preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
    expect(gfx.resolve(next, 'high').bloom).toBe(gfx.presetTier('low', 'bloom'));
    expect(gfx.choosePreset(saved, 'auto').preset).toBe('auto');
  });

  test('describe and adaptive steps', () => {
    const d = gfx.describe(gfx.resolve({ preset: 'high' }, 'low'), [1280, 800]);
    expect(d).toMatch(/2048² shadows/);
    expect(d).toMatch(/1280×800 px/);
    expect(gfx.describe(gfx.resolve({ preset: 'low' }, 'low'))).toMatch(/no shadows/);
    expect(gfx.adaptStep(1, 30)).toBe(0.9);
    expect(gfx.adaptStep(0.6, 40)).toBe(0.6);
    expect(gfx.adaptStep(0.9, 10)).toBe(0.95);
    expect(gfx.adaptStep(1, 10)).toBe(1);
    expect(gfx.adaptStep(0.8, 20)).toBe(0.8);
  });

  test('panel strings exist for every supported locale and category', () => {
    const want = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
    for (const loc of want) {
      const L = panel.LOCALES[loc];
      expect(L).toBeDefined();
      for (const cat of Object.keys(gfx.CATEGORIES)) {
        expect(L.cat[cat]).toBeTruthy();
        for (const t of gfx.CATEGORIES[cat]) expect(L.tier[t]).toBeTruthy();
      }
      for (const p of gfx.PRESETS) expect(L.preset[p]).toBeTruthy();
      expect(L.auto).toContain('{t}');
      expect(L.fromPreset).toContain('{t}');
    }
    expect(panel.pickLocale('de')).toBe('de-DE');
    expect(panel.pickLocale('es-MX')).toBe('es-419');
    expect(panel.pickLocale('es-ES')).toBe('es-ES');
    expect(panel.pickLocale('fr-CA')).toBe('fr-CA');
    expect(panel.pickLocale('ja-JP')).toBe('en-US');
  });
});
