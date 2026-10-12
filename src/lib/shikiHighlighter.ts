import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
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
  const base = filePath.split("/").pop() ?? "";
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
        import("shiki/langs/sql.mjs"),
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((error) => {
      cached = null;
      if (import.meta.env.DEV) console.error("[shiki] failed to initialize shared highlighter", error);
      throw error;
    });
  }
  return cached;
}

type LanguageModule = Promise<{ default: LanguageRegistration[] }>;

/**
 * Languages loaded only when a code block names them. Each is its own chunk,
 * so they cost nothing at startup and only ship as small files in the app.
 * Large, rarely seen grammars (OCaml, Objective-C, Less, ...) stay out; their
 * blocks show as plain code.
 */
const ON_DEMAND_LANGS: Record<string, () => LanguageModule> = {
  diff: () => import("shiki/langs/diff.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  shellsession: () => import("shiki/langs/shellsession.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  csv: () => import("shiki/langs/csv.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
};

/** Fence names agents use that a grammar only knows once loaded, or not at all. */
const LANG_ALIASES: Record<string, string> = {
  postgres: "sql", postgresql: "sql", psql: "sql", pgsql: "sql", plpgsql: "sql", mysql: "sql",
  sqlite: "sql", tsql: "sql", mssql: "sql", plsql: "sql", bigquery: "sql", snowflake: "sql",
  sparksql: "sql", redshift: "sql", duckdb: "sql",
  patch: "diff", kt: "kotlin", kts: "kotlin", h: "c", "c++": "cpp", cc: "cpp", cxx: "cpp",
  hpp: "cpp", "c#": "csharp", cs: "csharp", rb: "ruby", dockerfile: "docker", makefile: "make",
  gql: "graphql", properties: "ini", ps: "powershell", ps1: "powershell", pwsh: "powershell",
  console: "shellsession", protobuf: "proto", tf: "terraform", tfvars: "terraform", hs: "haskell",
};

/** The highlighter's name for a code fence's language, e.g. "Postgres" → "sql". */
export function canonicalLang(lang: string): string {
  const name = lang.trim().toLowerCase();
  return LANG_ALIASES[name] ?? name;
}

/** Languages named by fenced code blocks in markdown. */
export function fenceLanguages(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm)) {
    names.add(canonicalLang(match[1]));
  }
  return [...names];
}

const loadedOnDemand = new Set<string>();
const loading = new Map<string, Promise<void>>();

/**
 * Load the on-demand languages among `names`. Returns null when there is
 * nothing to wait for, else the same promise per set (safe for React's `use`).
 * A grammar that fails to load just leaves its blocks as plain code.
 */
export function loadLanguages(names: string[]): Promise<void> | null {
  const needed = names.filter((name) => name in ON_DEMAND_LANGS && !loadedOnDemand.has(name)).sort();
  if (needed.length === 0) return null;
  const key = needed.join(",");
  let pending = loading.get(key);
  if (!pending) {
    pending = getHighlighter()
      .then((highlighter) => Promise.all(needed.map(async (name) => {
        try {
          await highlighter.loadLanguage(...(await ON_DEMAND_LANGS[name]()).default);
          loadedOnDemand.add(name);
        } catch (error) {
          loadedOnDemand.add(name);
          if (import.meta.env.DEV) console.error(`[shiki] failed to load ${name}`, error);
        }
      })))
      .then(() => undefined, () => undefined);
    loading.set(key, pending);
  }
  return pending;
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
