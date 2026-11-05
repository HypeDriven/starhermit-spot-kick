// Localization: the browser build's tables (US-English text as the key; en-GB,
// es-ES and fr-CA list only their differences from en-US, es-419 and fr-FR) in
// assets/strings.json, on the engine's strings: the interface language the
// runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's), its locale chain, and the
// account lines the engine keeps (`starhermit.*`). Every string is drawn
// through T() each frame, so a change shows on the next frame, mid-match
// included, without touching the match or its socket.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
