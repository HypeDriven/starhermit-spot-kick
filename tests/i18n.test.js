// Spot Kick — localization coverage: every English key the markup, code and
// content show to players is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive, the language
// follows sh-language.js and switches live, and the account / Graphics
// strings cover the nine locales (including the terms-consent notice).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—' };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] || m);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'");
const STR = String.raw`'((?:[^'\\]|\\.)*)'`;

function tables() {
  const sb = { self: {} };
  vm.runInNewContext(read('js/strings.js'), sb);
  return sb.self.SK_STRINGS;
}

/** Static <body> markup keys, as js/i18n.js collects them (data-i18n-skip subtrees left out). */
function htmlKeys(html) {
  const keys = new Set();
  let body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/g, '');
  for (;;) {
    const m = /<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>/.exec(body);
    if (!m) break;
    const tag = m[1];
    const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, t;
    while (depth && (t = re.exec(body))) depth += t[1] ? -1 : 1;
    body = body.slice(0, m.index) + body.slice(t ? re.lastIndex : body.length);
  }
  body = body.replace(/<kbd\b[^>]*>[\s\S]*?<\/kbd>/g, '<kbd></kbd>');
  for (const m of body.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) keys.add(norm(decode(m[2])));
  for (const m of body.matchAll(/>([^<>]+)</g)) keys.add(norm(decode(m[1])));
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/** Keys passed to T() (incl. both arms of T(c ? 'a' : 'b')) and the English tables kept in code. */
function codeKeys() {
  const keys = new Set();
  for (const f of ['js/ui.js', 'js/bootstrap.js', 'js/platform.js']) {
    const src = read(f);
    for (const re of [new RegExp(String.raw`\bT\(` + STR, 'g'),
      new RegExp(String.raw`\bT\([^;\n]*?\?\s*` + STR + String.raw`\s*:\s*` + STR, 'g'),
      new RegExp(String.raw`appendBoard\(` + STR, 'g')]) {
      for (const m of src.matchAll(re)) m.slice(1).forEach((g) => { if (g !== undefined) keys.add(unq(g)); });
    }
    for (const name of ['WORD', 'GOAL', 'REASONS', 'OUTCOME', 'TERMINAL', 'ACHIEVEMENTS']) {
      const block = src.match(new RegExp('const ' + name + ' = [\\[{]([\\s\\S]*?)[\\]}];'));
      if (!block) continue;
      const vals = name === 'ACHIEVEMENTS' ? /(?:name|desc):\s*'((?:[^'\\]|\\.)*)'/g : /:\s*'((?:[^'\\]|\\.)*)'/g;
      for (const m of block[1].matchAll(vals)) keys.add(unq(m[1]));
    }
    const sync = src.match(/T\(\{ saving: '([^']+)', synced: '([^']+)', offline: '([^']+)' \}/);
    if (sync) sync.slice(1).forEach((k) => keys.add(k));
  }
  // audio.js caption texts (translated by bootstrap's onCaption hook)
  const cap = read('js/audio.js').match(/function captionFor\(name\) \{[\s\S]*?\{([\s\S]*?)\}\[name\]/);
  for (const m of cap[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) if (m[1]) keys.add(unq(m[1]));
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

function contentKeys() {
  global.self = global;
  const content = require('../js/content.js');
  const keys = [];
  content.THEMES.forEach((t) => keys.push(t.name));
  content.TUTORIAL_STEPS.forEach((s) => keys.push(s.title, s.body));
  content.CHALLENGES.forEach((c) => keys.push(c.name, c.blurb));
  content.PRACTICE_DIFFICULTIES.forEach((d) => keys.push(d.name, d.blurb));
  return keys;
}

function usedKeys() { return [...new Set([...htmlKeys(read('index.html')), ...codeKeys(), ...contentKeys()])].sort(); }

describe('localization', () => {
  test('every used key is translated in every full locale; placeholders intact; no stale rows', () => {
    const T = tables();
    const used = new Set(usedKeys());
    const problems = [];
    for (const loc of FULL) for (const k of used) if (!Object.prototype.hasOwnProperty.call(T[loc] || {}, k)) problems.push(loc + ' missing: ' + k);
    for (const [loc, table] of Object.entries(T)) {
      if (!LOCALES.includes(loc)) problems.push('unknown locale ' + loc);
      for (const [k, v] of Object.entries(table)) {
        if (!used.has(k)) { problems.push(loc + ' unused: ' + k); continue; }
        const want = (k.match(/\{\w+\}/g) || []).sort().join();
        const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
        if (want !== got) problems.push(loc + ' placeholders: ' + k);
      }
    }
    for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!T[loc]) problems.push('no ' + loc + ' table');
    expect(problems).toEqual([]);
    expect(used.size).toBeGreaterThan(200);
  });

  test('the locale follows sh-language and switches live', () => {
    const events = [];
    const doc = { documentElement: { lang: 'en' }, body: null, dispatchEvent: (e) => events.push(e.detail.lang), addEventListener() {} };
    const sb = {
      document: doc, location: { search: '' }, navigator: { languages: ['de-DE'], language: 'de-DE' },
      localStorage: { getItem: () => null, setItem: () => {} },
      CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } }, URLSearchParams,
    };
    sb.self = sb; sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(read('sh-language.js'), sb);
    vm.runInContext(read('js/strings.js'), sb);
    vm.runInContext(read('js/i18n.js'), sb);
    const I = sb.SKI18N;
    expect(I.lang).toBe('de-DE');
    expect(doc.documentElement.lang).toBe('de-DE');
    expect(I.T('Kick!')).toBe('Schuss!');
    I.language.setChoice('fr-CA');
    expect(I.lang).toBe('fr-CA');
    expect(events[events.length - 1]).toBe('fr-CA');
    expect(I.T('Score {a}–{b}', { a: 2, b: 1 })).toBe('Pointage 2–1');
    I.language.setChoice('it-IT');
    expect(I.T('Stage {n}', { n: 4 })).toBe('Tappa 4');
  });

  test('account strings (incl. terms consent) and Graphics strings cover all nine locales', () => {
    const sb = { self: {} };
    sb.self = sb;
    vm.runInNewContext(read('js/sh-strings.js'), sb);
    const SHS = sb.SpotKickShStrings;
    for (const l of LOCALES) {
      for (const k of ['signIn', 'expiredTitle', 'termsTitle', 'termsBody', 'relaunch', 'lbPosting']) expect(SHS.STRINGS[l][k]).toBeTruthy();
    }
    const gfx = read('js/gfxpanel.js');
    expect(gfx).toMatch(/function setLang\(lang\)/);
    expect(read('js/bootstrap.js')).toMatch(/SpotKickGfxPanel\.setLang\(gameLang\(\)\)/);
  });

  test('index.html loads sh-language.js, strings.js and i18n.js before the game scripts', () => {
    const html = read('index.html');
    const at = (src) => html.indexOf('src="./' + src + '"');
    expect(at('sh-language.js')).toBeGreaterThan(0);
    expect(at('sh-language.js')).toBeLessThan(at('js/i18n.js'));
    expect(at('js/strings.js')).toBeLessThan(at('js/i18n.js'));
    expect(at('js/i18n.js')).toBeLessThan(at('js/ui.js'));
  });
});

module.exports = { usedKeys };
