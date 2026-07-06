import { isMac } from "./platform";

export const TERMINAL_FONT_SIZE = 14;
export const TERMINAL_FONT_FAMILY = "MesloLGS NF";
export const TERMINAL_LINE_HEIGHT = 1;

// The bundled MesloLGS NF always resolves first; the rest of the chain covers
// both macOS (Menlo, Monaco) and Windows (Cascadia Mono, Consolas) so a failed
// user font never lands on the browser's generic default.
const DEFAULT_FALLBACKS = [
  "MesloLGS NF",
  "Menlo",
  "Monaco",
  "Cascadia Mono",
  "Consolas",
  "Courier New",
  "monospace",
];
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

export const FONT_OPTIONS: readonly { id: string; label: string }[] = isMac
  ? [
      { id: "MesloLGS NF", label: "MesloLGS Nerd Font" },
      { id: "Menlo", label: "Menlo" },
      { id: "Monaco", label: "Monaco" },
      { id: "Courier", label: "Courier" },
      { id: "Andale Mono", label: "Andale Mono" },
    ]
  : [
      { id: "MesloLGS NF", label: "MesloLGS Nerd Font" },
      { id: "Cascadia Mono", label: "Cascadia Mono" },
      { id: "Cascadia Code", label: "Cascadia Code" },
      { id: "Consolas", label: "Consolas" },
      { id: "Courier New", label: "Courier New" },
    ];

export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18] as const;

/**
 * Normalize a fontFamily value to a clean font name for storage.
 * Strips CSS quotes and fallback chains from legacy config values.
 */
export function normalizeTerminalFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return TERMINAL_FONT_FAMILY;

  // If it matches a preset exactly, return it
  if (FONT_OPTIONS.some((font) => font.id === trimmed)) return trimmed;

  // Strip legacy CSS-style values: "'0xProto', monospace" → "0xProto"
  const primary = trimmed.split(",")[0]!.trim();
  const unquoted = primary.replace(/^['"]|['"]$/g, "");
  return unquoted || TERMINAL_FONT_FAMILY;
}

function escapeCSSFontFamily(fontFamily: string): string {
  return fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a CSS font-family string for xterm.js from a stored font name.
 * Wraps each font in double quotes and appends fallback chain.
 */
export function buildCSSFontFamily(fontName: string): string {
  const fonts = [fontName, ...DEFAULT_FALLBACKS.filter((f) => f !== fontName)];
  return fonts
    .map((font) => {
      const trimmed = font.trim();
      return GENERIC_FAMILIES.has(trimmed.toLowerCase())
        ? trimmed
        : `"${escapeCSSFontFamily(trimmed)}"`;
    })
    .join(", ");
}
