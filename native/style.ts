// The look of the screens, the HUD and the trays: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects) take. The runtime's high contrast option is the old
// body.high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#0b1220", panel: "#0a1120d1", text: "#e8edf5", dim: "#bcc3cd", accent: "#5aa0ff", "accent-2": "#3564d6", danger: "#ff6a5e",
  chip: "#24344f", confirm: "#1e7a4a", done: "#1e5c43", hud: "#1e2d46d9", overlay: "#060b16", edge: "#2a3a55", card: "#142036e6",
};
/** body.high-contrast. */
const CONTRAST: Tokens = { bg: "#000000", panel: "#000000eb", text: "#ffffff", dim: "#e6e6e6", accent: "#ffd23f", "accent-2": "#005fcc", overlay: "#000000" };

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.text!, muted: BASE.dim!, panel: "#0a1120", control: BASE.chip!, hovered: "#2d4063",
    pressed: "#3b5480", field: "#1a2942", accent: BASE.accent!, focus: BASE.accent!, outline: BASE.edge!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$accent", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$edge", radius: 4 } } },
    tooltip: { background: "#0a1120", text: { color: "$text" }, radius: 6, padding: 6 },
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#00000000" } } },
  });
  key = "";
  applyTokens(false);
}

let key = "";
/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({ text: current.text!, muted: current.dim!, accent: current.accent!, focus: current.accent! });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
