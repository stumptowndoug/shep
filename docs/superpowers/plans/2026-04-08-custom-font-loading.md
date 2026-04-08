# Custom Font Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load user-installed fonts into the browser's font system via Tauri IPC so the xterm.js CanvasAddon can render them.

**Architecture:** Rust uses macOS CoreText API to resolve a font family name to file paths and reads the font bytes. JS receives the bytes via IPC, creates `FontFace` objects from the ArrayBuffer, and adds them to `document.fonts`. Once loaded, fonts are available to Canvas 2D and xterm.js renders them correctly.

**Tech Stack:** Rust (core-text crate, CoreText/CoreFoundation), TypeScript (FontFace API), Tauri v2 IPC

---

### Task 1: Rust Font Resolution Module

**Files:**
- Create: `src-tauri/src/fonts.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add core-text dependency to Cargo.toml**

Add `core-text` and `core-foundation` after the existing `notify` dependency in `src-tauri/Cargo.toml`:

```toml
core-text = "21"
core-foundation = "0.10"
```

- [ ] **Step 2: Create `src-tauri/src/fonts.rs`**

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
    /// Raw font file bytes (TTF/OTF)
    pub data: Vec<u8>,
    /// Font style, e.g. "Regular", "Bold", "Italic", "Bold Italic"
    pub style: String,
}

/// Resolve a font family name to its on-disk font files using the macOS CoreText API.
/// Returns an empty Vec on non-macOS platforms or if the family is not found.
#[cfg(target_os = "macos")]
pub fn resolve_font_files_for_family(family_name: &str) -> Vec<FontFile> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_text::font_descriptor::{self, CTFontDescriptor};

    let cf_family = CFString::new(family_name);
    let mandatory_attrs =
        core_foundation::dictionary::CFDictionary::from_CFType_pairs(&[(
            CFString::from_static_string(font_descriptor::kCTFontFamilyNameAttribute),
            cf_family.as_CFType(),
        )]);

    let desc = font_descriptor::new_from_attributes(&mandatory_attrs);
    let matching = desc.create_matching_font_descriptors();

    let Some(descriptors) = matching else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for i in 0..descriptors.len() {
        let desc: CTFontDescriptor = unsafe {
            let ptr = core_foundation::array::CFArray::get_unchecked(
                &descriptors, i,
            );
            TCFType::wrap_under_get_rule(ptr)
        };

        // Get the file URL for this font descriptor
        let url = unsafe {
            let key = CFString::from_static_string(
                font_descriptor::kCTFontURLAttribute,
            );
            let val = desc.attribute(&key);
            if val.is_none() {
                continue;
            }
            let url_ref: core_foundation::url::CFURL =
                TCFType::wrap_under_get_rule(
                    val.unwrap().as_CFTypeRef() as core_foundation::url::CFURLRef,
                );
            url_ref
        };

        let Some(path) = url.to_path() else {
            continue;
        };

        // Read font file bytes
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };

        // Get the style name (Regular, Bold, etc.)
        let style = {
            let key = CFString::from_static_string(
                font_descriptor::kCTFontStyleNameAttribute,
            );
            desc.attribute(&key)
                .and_then(|val| unsafe {
                    let cf_str: CFString =
                        TCFType::wrap_under_get_rule(val.as_CFTypeRef() as _);
                    Some(cf_str.to_string())
                })
                .unwrap_or_else(|| "Regular".to_string())
        };

        result.push(FontFile { data, style });
    }

    result
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_font_files_for_family(_family_name: &str) -> Vec<FontFile> {
    Vec::new()
}
```

- [ ] **Step 3: Verify Rust compiles**

Run from `src-tauri/`:
```bash
cargo check
```
Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/fonts.rs src-tauri/Cargo.toml
git commit -m "feat: add CoreText font resolution module"
```

---

### Task 2: Tauri Command + IPC Wiring

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `mod fonts;`)
- Modify: `src-tauri/src/commands.rs` (add `resolve_font_files` command)
- Modify: `src/lib/types.ts` (add `FontFile` type)
- Modify: `src/lib/tauri.ts` (add IPC wrapper)

- [ ] **Step 1: Add `mod fonts;` to `src-tauri/src/lib.rs`**

Add after the existing module declarations (after line 7):

```rust
mod fonts;
```

- [ ] **Step 2: Add the Tauri command to `src-tauri/src/commands.rs`**

Add this import at the top (after the existing `use crate::` imports around line 14):

```rust
use crate::fonts;
```

Add this command at the end of the file (before the closing of the file):

```rust
// ── Font commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn resolve_font_files(family_name: &str) -> Vec<fonts::FontFile> {
    fonts::resolve_font_files_for_family(family_name)
}
```

- [ ] **Step 3: Register the command in `src-tauri/src/lib.rs`**

Add `commands::resolve_font_files,` to the `tauri::generate_handler![]` list. Add it after `commands::open_url,` (line 128):

```rust
            commands::open_url,
            commands::resolve_font_files,
```

- [ ] **Step 4: Add `FontFile` type to `src/lib/types.ts`**

Add after the `TerminalSettings` interface (after line 47):

```typescript
export interface FontFile {
  data: number[];
  style: string;
}
```

- [ ] **Step 5: Add IPC wrapper to `src/lib/tauri.ts`**

Add the `FontFile` import to the existing imports (add after `PortInfo` on line 20):

```typescript
  FontFile,
```

Add the function at the end of the file (or in a `// ── Font commands ──` section):

```typescript
// ── Font commands ───────────────────────────────────────────────────

export function resolveFontFiles(familyName: string): Promise<FontFile[]> {
  return invoke("resolve_font_files", { familyName });
}
```

- [ ] **Step 6: Verify Rust compiles and TypeScript compiles**

```bash
cd src-tauri && cargo check
cd .. && pnpm tsc --noEmit
```

Expected: both compile without errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src/lib/types.ts src/lib/tauri.ts
git commit -m "feat: add resolve_font_files Tauri command and IPC wiring"
```

---

### Task 3: TypeScript Font Loader

**Files:**
- Create: `src/lib/fontLoader.ts`

- [ ] **Step 1: Create `src/lib/fontLoader.ts`**

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/fontLoader.ts
git commit -m "feat: add font loader utility for custom font loading via FontFace API"
```

---

### Task 4: Integrate Font Loading into Settings Store

**Files:**
- Modify: `src/stores/useTerminalSettingsStore.ts`

- [ ] **Step 1: Add loadCustomFont import**

Add to the imports at the top of `src/stores/useTerminalSettingsStore.ts` (after line 4):

```typescript
import { loadCustomFont } from "../lib/fontLoader";
```

- [ ] **Step 2: Update `loadSettings` to load custom font on startup**

Replace the `loadSettings` method (lines 31-47) with:

```typescript
  loadSettings: async () => {
    try {
      const settings = await getTerminalSettings();
      const normalizedSettings = {
        ...settings,
        fontFamily: normalizeTerminalFontFamily(settings.fontFamily),
      };
      // Load custom font into browser before applying to terminals
      await loadCustomFont(normalizedSettings.fontFamily);
      set({ settings: normalizedSettings, hasLoaded: true, error: null });
      applyTerminalSettings(normalizedSettings);
      if (normalizedSettings.fontFamily !== settings.fontFamily) {
        saveTerminalSettings(normalizedSettings).catch((error) => {
          set({ error: String(error) });
        });
      }
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },
```

- [ ] **Step 3: Update `updateSettings` to load custom font before applying**

Replace the `updateSettings` method (lines 50-70) with:

```typescript
  updateSettings: async (partial) => {
    const prev = get().settings;
    const next = {
      ...prev,
      ...partial,
      ...(partial.fontFamily !== undefined
        ? { fontFamily: normalizeTerminalFontFamily(partial.fontFamily) }
        : {}),
    };
    // Load custom font into browser before applying to terminals
    await loadCustomFont(next.fontFamily);
    // Optimistic update
    set({ settings: next, isSaving: true, error: null });
    applyTerminalSettings(next);
    try {
      await saveTerminalSettings(next);
      set({ isSaving: false });
    } catch (error) {
      // Rollback
      set({ settings: prev, isSaving: false, error: String(error) });
      applyTerminalSettings(prev);
    }
  },
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src/stores/useTerminalSettingsStore.ts
git commit -m "feat: load custom fonts via FontFace API before applying terminal settings"
```

---

### Task 5: Remove Diagnostic Logging

**Files:**
- Modify: `src/components/terminal/terminalTheme.ts` (remove `[font-diag]` logging)
- Modify: `src/components/terminal/TerminalView.tsx` (remove `[font-diag]` logging)

- [ ] **Step 1: Remove debug logging from `terminalTheme.ts`**

Remove the entire `if (import.meta.env.DEV)` block that contains `[font-diag applySettings]` log statements from the `applyTerminalSettings` function. Keep the `clearTextureAtlas()` call and everything else.

- [ ] **Step 2: Remove debug logging from `TerminalView.tsx`**

Remove the entire `if (import.meta.env.DEV)` block that contains `[font-diag attachTerminal]` log statements from the `attachTerminal` function. Keep the font change detection, settings re-application, and `clearTextureAtlas()` call.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm tsc --noEmit
```

Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/terminalTheme.ts src/components/terminal/TerminalView.tsx
git commit -m "chore: remove font diagnostic logging"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Build and run the app**

```bash
pnpm tauri dev
```

- [ ] **Step 2: Test custom font**

1. Open Settings (gear icon)
2. In the Terminal section, type "MonoLisaNikos Nerd Font" in the custom font input
3. Press Enter or click outside the input (blur)
4. Close Settings
5. **Verify**: Terminal text should render in MonoLisaNikos Nerd Font, not monospace

- [ ] **Step 3: Test preset font switching**

1. Open Settings
2. Click "MesloLGS Nerd Font" preset button
3. Close Settings
4. **Verify**: Terminal renders in MesloLGS NF

- [ ] **Step 4: Test persistence**

1. Set custom font to "MonoLisaNikos Nerd Font"
2. Close and restart the app (`pnpm tauri dev`)
3. **Verify**: Terminal renders in the custom font on startup (loadSettings loads it)

- [ ] **Step 5: Test non-existent font**

1. Type "NonExistentFont" in the custom font input
2. Press Enter
3. Close Settings
4. **Verify**: Terminal falls back to monospace gracefully, no errors in console
