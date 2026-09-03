'use strict';

const content = require('../js/content');
const rules = require('../js/rules');

describe('content', () => {
  test('offline validators pass on shipped content', () => {
    const v = content.validateContent();
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test('launch scope: >=40 journey stages, 5 themes, challenges, tutorial', () => {
    expect(content.JOURNEY.length).toBe(40);
    expect(content.THEMES.length).toBe(5);
    expect(content.CHALLENGES.length).toBeGreaterThanOrEqual(5);
    expect(content.TUTORIAL_STEPS.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(content.JOURNEY.map(s => s.id));
    expect(ids.size).toBe(40);
  });

  test('journey stages are versioned data with goals, seeds, constraints, themes', () => {
    for (const s of content.JOURNEY) {
      expect(typeof s.seed).toBe('number');
      expect(s.version).toBe(content.CONTENT_VERSION);
      expect(['win', 'win-by-2']).toContain(s.goal);
      expect(content.THEMES.some(t => t.id === s.theme)).toBe(true);
      // every stage produces a playable opening
      const st = rules.createInitialState({ seed: s.seed, rounds: s.rounds, constraints: s.constraints });
      expect(rules.legalActions(st).length).toBeGreaterThan(0);
    }
  });

  test('daily seed is deterministic per UTC day and differs across days', () => {
    const a1 = content.dailySeedFor('2026-08-30');
    const a2 = content.dailySeedFor('2026-08-30');
    const b = content.dailySeedFor('2026-08-31');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    const d = content.dailyFor('2026-08-30');
    expect(d.excluded).toBe(false);
    expect(content.THEMES.some(t => t.id === d.theme)).toBe(true);
  });

  test('challenge constraints never soft-lock the shooter', () => {
    for (const ch of content.CHALLENGES) {
      const st = rules.createInitialState({ seed: ch.seed, rounds: ch.rounds, constraints: ch.constraints });
      st.phase = 'shooter';
      const shots = rules.legalActions(st).filter(a => a.type === 'shoot');
      expect(shots.length).toBeGreaterThan(0);
    }
  });
});
