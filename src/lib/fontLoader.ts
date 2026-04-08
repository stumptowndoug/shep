import { resolveFontFiles } from "./tauri";
import { FONT_OPTIONS } from "./terminalConfig";

/** Font family names that are already loaded or don't need loading. */
const SKIP_FAMILIES = new Set([
  ...FONT_OPTIONS.map((f) => f.label),
  "MesloLGS NF",
  "Menlo",
  "Monaco",
  "Courier New",
  "monospace",
  "ui-monospace",
]);

/** Tracks which font families have already been loaded in this session. */
const loadedFamilies = new Set<string>();

/**
 * Extract the primary (first) bare font name from a CSS font-family string.
 * e.g. "'MonoLisaNikos Nerd Font', monospace" → "MonoLisaNikos Nerd Font"
 */
function extractPrimaryFamily(fontFamily: string): string {
  const first = fontFamily.split(",")[0].trim();
  // Strip surrounding quotes
  if (
    (first.startsWith("'") && first.endsWith("'")) ||
    (first.startsWith('"') && first.endsWith('"'))
  ) {
    return first.slice(1, -1);
  }
  return first;
}

/**
 * Map a FontFace style string (e.g. "Bold Italic") to CSS font-style
 * and font-weight descriptor values.
 */
function parseFontStyle(style: string): { weight: string; style: string } {
  const lower = style.toLowerCase();
  const isBold = lower.includes("bold");
  const isItalic = lower.includes("italic") || lower.includes("oblique");
  return {
    weight: isBold ? "bold" : "normal",
    style: isItalic ? "italic" : "normal",
  };
}

/**
 * Load a custom font into the browser's font system so it is available
 * to Canvas 2D (and therefore to xterm.js CanvasAddon).
 *
 * Resolves the font family name to on-disk font files via Tauri IPC,
 * then creates FontFace objects from the binary data and adds them
 * to document.fonts.
 *
 * @returns true if at least one font face was loaded, false otherwise.
 */
export async function loadCustomFont(fontFamily: string): Promise<boolean> {
  const familyName = extractPrimaryFamily(fontFamily);

  // Skip system/preset/bundled fonts — they're already available
  if (SKIP_FAMILIES.has(familyName)) return false;

  // Skip if already loaded in this session
  if (loadedFamilies.has(familyName)) return true;

  try {
    const fontFiles = await resolveFontFiles(familyName);
    if (fontFiles.length === 0) return false;

    let loaded = false;
    for (const file of fontFiles) {
      try {
        const buffer = new Uint8Array(file.data).buffer;
        const { weight, style } = parseFontStyle(file.style);
        const face = new FontFace(familyName, buffer, { weight, style });
        await face.load();
        document.fonts.add(face);
        loaded = true;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(
            `Failed to load font face "${familyName}" (${file.style}):`,
            e,
          );
        }
      }
    }

    if (loaded) {
      loadedFamilies.add(familyName);
    }
    return loaded;
  } catch (e) {
    if (import.meta.env.DEV) {
      console.error(`Failed to resolve font files for "${familyName}":`, e);
    }
    return false;
  }
}
