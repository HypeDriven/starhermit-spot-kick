'use strict';
// js/progress.js — the save model the engine client keeps in its cloud save:
// normalising, the two-device merge, the browser build's cloud slot read as a
// foreign save, achievements, and the settings-KV values that carry over.
const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../js/session');
const P = require('../js/progress');

test('normalize fills every field and drops malformed ones', () => {
  const s = P.normalize({ journeyDone: ['j01', 3], stats: { goals: '4', wins: 'x' }, streak: 2 });
  assert.deepEqual(s.journeyDone, ['j01']);
  assert.equal(s.stats.goals, 4);
  assert.equal(s.stats.wins, 0);
  assert.equal(s.streak, 2);
  assert.equal(s.tutorialDone, false);
  assert.deepEqual(P.normalize(null), P.normalize({}));
});

test('mergeSaves keeps both devices\' progress (js/ui.js mergeSaves)', () => {
  const a = { journeyDone: ['j01', 'j02'], achievements: { first_win: 200 }, dailyResults: { '2026-10-01': { won: true, score: '3–1', hash: 'a' } },
    streak: 1, bestStreak: 4, stats: { goals: 10, saves: 2, matches: 5 } };
  const b = { journeyDone: ['j03'], achievements: { first_win: 100, keeper_10: 300 }, dailyResults: { '2026-10-01': { won: false, score: '0–2', hash: 'b' }, '2026-10-02': { won: true, score: '2–0', hash: 'c' } },
    streak: 3, bestStreak: 3, stats: { goals: 4, saves: 9, matches: 7 }, tutorialDone: true };
  const m = P.mergeSaves(a, b); // a is the remote copy
  assert.deepEqual(m.journeyDone, ['j01', 'j02', 'j03']);
  assert.deepEqual(m.achievements, { first_win: 100, keeper_10: 300 });
  assert.equal(m.dailyResults['2026-10-01'].hash, 'a'); // the remote copy first
  assert.equal(m.dailyResults['2026-10-02'].hash, 'c');
  assert.equal(m.streak, 3);
  assert.equal(m.bestStreak, 4);
  assert.deepEqual([m.stats.goals, m.stats.saves, m.stats.matches], [10, 9, 7]);
  assert.equal(m.tutorialDone, true);
  assert.ok(P.same(m, P.mergeSaves(m, m)));
  assert.ok(P.same({ streak: 1, journeyDone: [] }, { journeyDone: [], streak: 1 })); // key order ignored
});

test('the browser build\'s cloud slot (session.encodeSave) reads as a foreign save', () => {
  const doc = { journeyDone: ['j01'], achievements: { first_goal: 1 }, dailyResults: {}, streak: 0, bestStreak: 1, stats: { goals: 3, saves: 1, curvedGoals: 0, wins: 1, matches: 2, dailies: 0 } };
  const text = session.encodeSave(doc);
  const got = P.readForeign(text);
  assert.deepEqual(got.journeyDone, ['j01']);
  assert.equal(got.stats.goals, 3);
  assert.equal(P.readForeign(text.replace('"goals":3', '"goals":9')), null); // checksum
  assert.equal(P.readForeign('garbage'), null);
  assert.equal(P.readForeign(null), null);
});

test('achievements unlock once', () => {
  const s = P.normalize(null);
  assert.equal(P.unlock(s, 'first_win', 5).key, 'first_win');
  assert.equal(P.unlock(s, 'first_win', 6), null);
  assert.equal(s.achievements.first_win, 5);
  assert.equal(P.unlock(s, 'nope', 1), null);
  assert.equal(P.ACHIEVEMENTS.length, 8);
});

test('the settings KV: the game\'s options carry over, the rest is the runtime\'s', () => {
  const old = P.readLegacySettings({ music: 40, theme: 'ember', leftHanded: true, timingAssist: 'yes', captions: false, tutorialDone: true, gfx: {} });
  assert.deepEqual(old.options, { theme: 'ember', leftHanded: true, captions: false });
  assert.equal(old.tutorialDone, true);
  assert.equal(P.pickOption('theme', 'nowhere'), undefined);
  assert.equal(P.pickOption('theme', 'mono'), 'mono');
  for (const k of P.OPTION_KEYS) assert.ok(P.BROWSER_KEYS.includes(k), k);
});
