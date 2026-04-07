# Custom Font Loading via CoreText + FontFace API

## Problem

The Canvas 2D API in Tauri's WKWebView cannot access user-installed fonts from `~/Library/Fonts/`. The xterm.js CanvasAddon renders all terminal text using `ctx.fillText()` on HTMLCanvasElement, so custom fonts never render — they silently fall back to the generic monospace font. System fonts (Menlo, Monaco) work because they're in `/System/Library/Fonts/`. The bundled MesloLGS NF works because it's loaded via `@font-face` with a `url()` pointing to a Vite-bundled asset.

## Solution

Load custom font files via Tauri IPC: Rust uses macOS CoreText API to resolve a font family name to file paths, reads the font bytes, and returns them to JS. The frontend creates `FontFace` objects from the ArrayBuffer data and adds them to `document.fonts`. Fonts loaded via the FontFace API with binary data are available to Canvas 2D in all browsers including WKWebView.

## Architecture

```
User types "MonoLisaNikos Nerd Font" in settings → onBlur
  → normalizeTerminalFontFamily() → "'MonoLisaNikos Nerd Font', monospace"
  → updateTermSettings({ fontFamily: ... })
  → Zustand store saves + calls applyTerminalSettings()
  → NEW: loadCustomFont("MonoLisaNikos Nerd Font")
    → Tauri IPC: resolve_font_files("MonoLisaNikos Nerd Font")
    → Rust: CoreText API → finds font file paths → reads bytes
    → Returns Vec<FontFileData> to JS
    → JS: new FontFace(name, bytes) → document.fonts.add()
    → Font now available to Canvas 2D
  → term.options.fontFamily set → clearTextureAtlas() → refresh
```

## Components

### Rust: Font Resolution (`src-tauri/src/fonts.rs`)

- New Tauri command: `resolve_font_files(family_name: String) -> Vec<FontFile>`
- Uses the `core-text` crate (or `core-foundation` + `core-text` bindings) to:
  1. Create a font descriptor matching the given family name
  2. Find all font descriptors in the system that match
  3. Get the file URL for each matched descriptor
  4. Read the font file bytes from disk
- Returns a `Vec<FontFile>` where each entry contains:
  - `data: Vec<u8>` — the raw font file bytes
  - `style: String` — e.g. "Regular", "Bold", "Italic", "BoldItalic"
- Register the command in `src-tauri/src/lib.rs`
- Platform-specific: macOS only for now. On other platforms, the command returns an empty Vec (graceful degradation).

### TypeScript: Font Loader (`src/lib/fontLoader.ts`)

- `loadCustomFont(fontFamily: string): Promise<boolean>` — main entry point
  - Extracts the bare font name from a CSS font-family string (strips single quotes, removes fallback fonts after commas)
  - Checks if font is already loaded (tracked in a module-level `Set<string>`)
  - Skips loading for preset/system fonts (Menlo, Monaco, Courier New, MesloLGS NF)
  - Calls Tauri IPC `resolve_font_files(familyName)`
  - For each returned font file:
    - Creates `new FontFace(familyName, arrayBuffer, { style, weight })` 
    - Calls `face.load()` then `document.fonts.add(face)`
  - Returns `true` if at least one font face was loaded, `false` otherwise

### Integration Points

1. **`useTerminalSettingsStore.updateSettings()`** — After normalizing fontFamily, call `loadCustomFont()` before `applyTerminalSettings()`. Font loading is async, so `applyTerminalSettings` should be called after the font is loaded.

2. **`useTerminalSettingsStore.loadSettings()`** — On app startup, after loading persisted settings from Rust, call `loadCustomFont()` for the stored fontFamily. This ensures custom fonts are available before any terminal renders.

3. **`applyTerminalSettings()`** in `terminalTheme.ts` — Keeps the `clearTextureAtlas()` call that was already added. After a custom font is loaded into `document.fonts`, clearing the atlas forces the CanvasAddon to re-render glyphs with the now-available font.

4. **`attachTerminal()`** in `TerminalView.tsx` — Keeps the terminal settings re-application + `clearTextureAtlas()` for terminals that were hidden during font changes.

## Error Handling

- If font family not found on disk: `loadCustomFont` returns `false`, font falls back to monospace (current behavior, no regression)
- If font file read fails: same graceful fallback, error logged in DEV mode
- If FontFace constructor throws (corrupt font file): caught, logged, returns `false`
- No user-facing error notification — the font simply won't render if it can't be loaded

## CSP Impact

None. Font data arrives via Tauri IPC (not a URL fetch), and the `FontFace` constructor with an ArrayBuffer does not trigger CSP `font-src` checks.

## Platform Support

- **macOS**: Full support via CoreText API
- **Linux/Windows**: `resolve_font_files` returns empty Vec. Custom fonts won't load via this mechanism (same as current behavior). Platform-specific implementations can be added later using fontconfig (Linux) or DirectWrite (Windows).

## Files to Create/Modify

### New files
- `src-tauri/src/fonts.rs` — Rust font resolution module
- `src/lib/fontLoader.ts` — TypeScript font loading utility

### Modified files
- `src-tauri/src/lib.rs` — Register new Tauri command
- `src-tauri/Cargo.toml` — Add `core-text` and `core-foundation` crate dependencies
- `src/stores/useTerminalSettingsStore.ts` — Call `loadCustomFont()` in `updateSettings` and `loadSettings`
- `src/components/terminal/terminalTheme.ts` — Already has `clearTextureAtlas()` (keep as-is)
- `src/components/terminal/TerminalView.tsx` — Already has settings re-application (keep as-is)
- `src/lib/tauri.ts` — Add IPC wrapper for `resolve_font_files`
