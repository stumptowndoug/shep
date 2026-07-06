import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { hexLuminance, type ShepTheme } from "./themes";

/**
 * The set of languages and themes actually registered with the highlighter
 * lives in `getHighlighter()` below as explicit dynamic imports — that's the
 * source of truth for what Vite emits into `dist/`. Keep the two lists below
 * (EXT_TO_LANG, SHEP_TO_SHIKI) in sync with those imports so `langForFile`
 * and `shikiThemeFor` never hand back a name the highlighter can't resolve.
 */

/**
 * Shep theme → Shiki theme mapping. Each entry picks the Shiki theme whose
 * *syntax palette* feels closest to the Shep theme — same mood, similar
 * saturation, compatible background luminance. Note: Shep's theme only
 * controls the diff row backgrounds (green/red gutters); these mappings
 * control the colors of the code tokens *inside* each line.
 */
const SHEP_TO_SHIKI: Record<string, string> = {
  // Tokyo Night family — direct match in Shiki
  "tokyo-night": "tokyo-night",
  "tokyo-glass": "tokyo-night",

  // Dracula — direct match
  "dracula": "dracula",

  // Catppuccin — direct matches (mocha for dark, latte for light)
  "catppuccin": "catppuccin-mocha",
  "catppuccin-glass": "catppuccin-mocha",
  "catppuccin-latte": "catppuccin-latte",

  // Kanagawa — direct match (Wave is the default dark variant)
  "kanagawa": "kanagawa-wave",

  // Nightfox family — no Shiki port exists. Night Owl is the closest
  // in mood: both are muted cool-dark with soft accents. Night Owl Light
  // is the sibling for Dayfox (Shep's "nightfox-light").
  "nightfox-dark": "night-owl",
  "nightfox-glass": "night-owl",
  "nightfox-light": "night-owl-light",

  // Carbonfox — IBM Carbon-based, high contrast with vivid pink/blue
  // accents. GitHub Dark Default has the same corporate-clean vibe.
  "carbonfox": "github-dark-default",

  // Jellybeans — Nanotech's vintage muted pastel-dark. Vesper is a
  // minimal warm dark theme that captures the same understated mood.
  "jellybeans": "vesper",

  // Solarized — Shep's `solarized` is actually Solarized LIGHT
  // (appBg #fdf6e3). Must map to solarized-light, not solarized-dark.
  "solarized": "solarized-light",

  // Tokyo Day — Tokyo Night's official light variant. Shiki has no
  // Tokyo Day port; One Light has the same cool clean-light feel.
  "tokyo-day": "one-light",

  // GitHub Light — direct match
  "github-light": "github-light",
};

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

/** Pick a Shiki theme for a given Shep theme. Unknown Shep themes fall back
 *  based on background luminance so custom themes still get readable colors. */
export function shikiThemeFor(theme: ShepTheme): string {
  const mapped = SHEP_TO_SHIKI[theme.id];
  if (mapped) return mapped;
  return hexLuminance(theme.appBg) > 0.3 ? "github-light" : "tokyo-night";
}

/** Detect a Shiki language from a file path, or null if unsupported.
 *  Returning null skips the Shiki call entirely and falls back to plain text. */
export function langForFile(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Lazy singleton. First call initializes Shiki; subsequent calls reuse it.
 *
 * We use `createHighlighterCore` with *explicit* dynamic imports rather than
 * Shiki's bundled `createHighlighter`. The bundled variant references every
 * language under the sun via dynamic import, which causes Vite to emit a
 * chunk for each one into `dist/` — ~15MB of dead weight that never loads
 * but ships inside the .app. The core API only emits chunks for the imports
 * we actually list below.
 */
let cached: Promise<HighlighterCore> | null = null;
export function getHighlighter(): Promise<HighlighterCore> {
  if (!cached) {
    cached = createHighlighterCore({
      themes: [
        import("shiki/themes/tokyo-night.mjs"),
        import("shiki/themes/dracula.mjs"),
        import("shiki/themes/catppuccin-mocha.mjs"),
        import("shiki/themes/catppuccin-latte.mjs"),
        import("shiki/themes/kanagawa-wave.mjs"),
        import("shiki/themes/solarized-light.mjs"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
        import("shiki/themes/night-owl.mjs"),
        import("shiki/themes/night-owl-light.mjs"),
        import("shiki/themes/one-light.mjs"),
        import("shiki/themes/vesper.mjs"),
      ],
      langs: [
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/jsx.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/go.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/toml.mjs"),
        import("shiki/langs/yaml.mjs"),
        import("shiki/langs/bash.mjs"),
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((error) => {
      cached = null;
      console.error("[shiki] failed to initialize shared highlighter", error);
      throw error;
    });
  }
  return cached;
}

/** Tokenize a source string. Returns one ThemedToken array per line of
 *  input. Caller is responsible for having a supported language — pass the
 *  result of `langForFile` and skip the call if it's null. */
export async function highlightSource(
  source: string,
  lang: string,
  themeName: string,
): Promise<ThemedToken[][]> {
  const hl = await getHighlighter();
  const result = hl.codeToTokens(source, { lang, theme: themeName });
  return result.tokens;
}

export type { ThemedToken };
