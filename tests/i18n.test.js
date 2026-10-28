'use strict';
// Every string the engine client shows is translated in the nine locales:
// the English keys native/*.ts passes to T() / N() and the content and
// achievement names it shows (js/strings.js: es-419, de-DE, fr-FR, pt-BR and
// it-IT carry every key; en-GB, es-ES and fr-CA only their differences), and
// the account strings in js/sh-strings.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = require('../js/content');
const progress = require('../js/progress');
const sh = require('../js/sh-strings');

const ROOT = path.join(__dirname, '..');
const ctx = { self: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'strings.js'), 'utf8'), ctx);
const T = ctx.self.SK_STRINGS;
const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

function clientKeys() {
  const keys = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'native')).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(ROOT, 'native', f), 'utf8');
    for (const m of src.matchAll(/\b[TN]\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
    // English keys in tables the screens translate (zone names, terminal reasons, setup titles, captions)
    for (const m of src.matchAll(/name: "((?:[^"\\]|\\.)*)" \}/g)) keys.add(JSON.parse(`"${m[1]}"`));
  }
  for (const t of content.THEMES) keys.add(t.name);
  for (const s of content.TUTORIAL_STEPS) { keys.add(s.title); keys.add(s.body); }
  for (const c of content.CHALLENGES) { keys.add(c.name); keys.add(c.blurb); }
  for (const d of content.PRACTICE_DIFFICULTIES) { keys.add(d.name); keys.add(d.blurb); }
  for (const a of progress.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  ['decided before the last kick', 'after regulation kicks', 'in sudden death', 'a player left the match', 'Goals', 'Saves', 'Perfect kicks',
    'Off target', 'Invalid actions', 'Kicks taken', 'synced', 'saving…', 'offline'].forEach((k) => keys.add(k));
  return [...keys];
}

test('every client string is translated in the five full tables', () => {
  const keys = clientKeys();
  assert.ok(keys.length > 150, `found ${keys.length} keys`);
  for (const loc of FULL) {
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(T[loc], k) || !T[loc][k]);
    assert.deepEqual(missing, [], loc);
  }
});

test('placeholders survive translation', () => {
  for (const loc of [...FULL, 'en-GB', 'es-ES', 'fr-CA']) {
    for (const [k, v] of Object.entries(T[loc] || {})) {
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      assert.equal(got, want, `${loc}: ${k}`);
    }
  }
});

test('the account strings exist in every locale', () => {
  const keys = Object.keys(sh.STRINGS['en-US']);
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    for (const k of keys) assert.ok(sh.STRINGS[loc] && sh.STRINGS[loc][k], `${loc}.${k}`);
  }
});
