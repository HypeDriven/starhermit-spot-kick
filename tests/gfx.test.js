'use strict';

// js/gpu-level.js is a classic script before js/gfx.js in the page (window.StarHermitGpu).
globalThis.StarHermitGpu = require('../js/gpu-level');
const gfx = require('../js/gfx');
const panel = require('../js/gfxpanel');

describe('gfx quality model', () => {
  const DESK = { cores: 8, memoryGb: 8 };
  const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

  test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
    expect(gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', DESK)).toBe('low');
    expect(gfx.detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK)).toBe(0);
    expect(gfx.detectPreset('', DESK)).toBe('low'); // no WebGL
    expect(gfx.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(gfx.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK)).toBe('balanced');
    expect(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('high');
    expect(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    expect(gfx.detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe(20);
    expect(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    for (const [p, lv] of Object.entries(gfx.LEVELS)) expect(gfx.presetForLevel(lv)).toBe(p);
    expect(gfx.presetForLevel(3)).toBe('low');
    expect(gfx.presetForLevel(16)).toBe('high');
  });

  test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
    expect(gfx.detectPreset('Adreno (TM) 740', PHONE)).toBe('balanced');
    expect(gfx.detectLevel('Adreno (TM) 740', PHONE)).toBeLessThanOrEqual(9);
    expect(gfx.detectPreset('Apple M2', PHONE)).toBe('balanced');
    expect(gfx.detectPreset('SwiftShader', PHONE)).toBe('low');
  });

  test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
    const keys = ['material', 'pitch', 'ball', 'seg', 'crowd', 'motes', 'bloomRes'];
    for (const p of gfx.PRESETS) for (const k of keys) expect(gfx.BUDGETS[p][k]).toBeDefined();
    for (let i = 1; i < gfx.PRESETS.length; i++) for (const k of keys) {
      if (typeof gfx.BUDGETS.low[k] === 'number') expect(gfx.BUDGETS[gfx.PRESETS[i]][k]).toBeGreaterThanOrEqual(gfx.BUDGETS[gfx.PRESETS[i - 1]][k]);
    }
    expect(gfx.PRESETS.map(p => gfx.BUDGETS[p].material)).toEqual(['lambert', 'standard', 'physical', 'physical']);
    expect(gfx.PRESETS.map(p => gfx.BUDGETS[p].bloomRes)).toEqual([0.5, 0.5, 0.5, 1]); // half-res bloom below Ultra
    expect(gfx.resolve({ preset: 'high' }, 'low', 10).budget).toEqual(gfx.BUDGETS.high); // floor level = tuned budget
    expect(gfx.resolve({ preset: 'ultra' }, 'low', 0).budget).toEqual(gfx.resolve({ preset: 'ultra' }, 'ultra', 17).budget);
    expect(gfx.budgetFor('balanced', 9).crowd).toBeGreaterThan(gfx.budgetFor('balanced', 4).crowd);
    expect(gfx.budgetFor('ultra', 20).crowd).toBeLessThanOrEqual(gfx.CROWD_MAX);
    expect(gfx.budgetFor('ultra', 20).motes).toBeLessThanOrEqual(gfx.MOTE_MAX);
    expect(gfx.crowdCount(gfx.resolve({ preset: 'high' }, 'low', 10))).toBe(gfx.BUDGETS.high.crowd);
    expect(gfx.crowdCount(gfx.resolve({ preset: 'low' }, 'low', 0))).toBe(gfx.CROWD_SPARSE); // Low: sparse crowd
    const head = gfx.resolve({}, 'low', 0);
    expect(head.preset).toBe('low');
    expect(head.budget.material).toBe('lambert'); // headless SwiftShader: Low, Lambert
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
