// Localization: the browser build's tables (js/strings.js, US-English text as
// the key; en-GB, es-ES and fr-CA list only their differences from en-US,
// es-419 and fr-FR) and the account strings (js/sh-strings.js), in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replace the game's
// Language section (sh-language.js) and js/i18n.js's DOM re-labelling: every
// string is drawn through T() each frame, so a change shows on the next frame,
// mid-match included, without touching the match or its socket.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { ShStrings, Strings, type AccountStrings } from "./classic.ts";

export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };
const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (sh-language.js: es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US").replace("_", "-");
  const exact = LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "en-US";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

const hasOwn = Object.prototype.hasOwnProperty;
export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  let s = key;
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const t = Strings[l];
    if (t && hasOwn.call(t, key)) { s = t[key]!; break; }
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (hasOwn.call(vars, k) ? String(vars[k]) : m));
  return s;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account strings (sign-in, invite, the session notices, the leaderboard line). */
export function S(key: keyof AccountStrings, vars?: Vars): string {
  const table = ShStrings.STRINGS[locale] ?? ShStrings.STRINGS["en-US"]!;
  let s = table[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
