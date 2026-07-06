import { loadFontFamily } from "./tauri";
import { TERMINAL_FONT_FAMILY } from "./terminalConfig";
import { isMac } from "./platform";

/**
 * CSS font-stretch keywords, indexed 1..9 to match the `stretch` value we
 * receive from Rust. Index 0 is unused; the Rust side always emits 1..=9.
 */
const CSS_STRETCH = [
  "normal", // placeholder for index 0
  "ultra-condensed",
  "extra-condensed",
  "condensed",
  "semi-condensed",
  "normal",
  "semi-expanded",
  "expanded",
  "extra-expanded",
  "ultra-expanded",
] as const;

/**
 * Families that we never resolve via IPC. This includes the app-bundled
 * MesloLGS NF (loaded through @font-face in globals.css) and system fonts
 * that are always available to Canvas 2D without explicit loading.
 */
const SKIP_FAMILIES = new Set<string>([
  TERMINAL_FONT_FAMILY,
  "monospace",
  "ui-monospace",
  "Courier New",
  ...(isMac
    ? ["Menlo", "Monaco", "Courier", "Andale Mono"]
    : ["Consolas", "Cascadia Mono", "Cascadia Code", "Lucida Console"]),
]);

/** Families already registered with document.fonts in this session. */
const loadedFamilies = new Set<string>();

/**
 * In-flight load promises keyed by family name. Dedupes concurrent callers so
 * startup (loadSettings) and a quick user tab-switch don't both trigger an
 * IPC round trip for the same family.
 */
const inflight = new Map<string, Promise<boolean>>();

/**
 * Ensure every face of `family` is registered with `document.fonts`. Safe to
 * call with system/bundled family names — those short-circuit immediately.
 *
 * Returns `true` when the family is available to Canvas 2D rendering after
 * the call (including when it was already loaded or is a known system font),
 * `false` when the family could not be resolved on disk.
 */
export async function ensureFamilyLoaded(family: string): Promise<boolean> {
  if (!family || SKIP_FAMILIES.has(family)) return true;
  if (loadedFamilies.has(family)) return true;

  const existing = inflight.get(family);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const faces = await loadFontFamily(family);
      if (faces.length === 0) return false;

      let loadedAny = false;
      for (const face of faces) {
        try {
          const buffer = new Uint8Array(face.data).buffer;
          const stretch =
            face.stretch >= 1 && face.stretch <= 9
              ? CSS_STRETCH[face.stretch]
              : "normal";
          const fontFace = new FontFace(family, buffer, {
            weight: String(face.weight),
            style: face.italic ? "italic" : "normal",
            stretch,
          });
          await fontFace.load();
          document.fonts.add(fontFace);
          loadedAny = true;
        } catch (err) {
          if (import.meta.env.DEV) {
            console.error(`Failed to register font face for "${family}":`, err);
          }
        }
      }

      if (loadedAny) {
        await document.fonts.ready;
        loadedFamilies.add(family);
      }
      return loadedAny;
    } finally {
      inflight.delete(family);
    }
  })();

  inflight.set(family, promise);
  return promise;
}
