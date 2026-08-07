import type { ITheme } from "@xterm/xterm";
import { hexLuminance } from "../../lib/themes";
import type { ShepTheme } from "../../lib/themes";
import type { TerminalSettings } from "../../lib/types";
import { resizePty } from "../../lib/tauri";
import { buildCSSFontFamily } from "../../lib/terminalConfig";
import { preserveTerminalViewport } from "../../lib/terminalViewport";
import { terminalCache } from "./terminalCache";
import { reconcileTerminalRenderer } from "./terminalRenderer";

// Utility to make hex colors partially transparent
function withAlpha(hex: string, alpha: number): string {
  if (hex.startsWith("#") && (hex.length === 7 || hex.length === 9)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

function isLightTheme(theme: ShepTheme): boolean {
  return hexLuminance(theme.appBg) > 0.3;
}

// Preserve the perceived color of Shep's former translucent dark ANSI entries
// while giving xterm/WebGL a conventional opaque foreground palette.
function blendOpaque(base: string, foreground: string, opacity: number): string {
  if (!/^#[\da-f]{6}$/i.test(base) || !/^#[\da-f]{6}$/i.test(foreground)) {
    return foreground;
  }

  const channel = (hex: string, offset: number) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mix = (baseChannel: number, foregroundChannel: number) =>
    Math.round(baseChannel + (foregroundChannel - baseChannel) * opacity);
  const channels = [1, 3, 5].map((offset) =>
    mix(channel(base, offset), channel(foreground, offset)),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function createTerminalTheme(theme: ShepTheme): ITheme {
  const light = isLightTheme(theme);
  return {
    // Only explicit glass themes expose Shep's gradient/native window effect.
    // Solid themes give WebGL an opaque RGB background, avoiding its behavior
    // of turning transparent's zero RGB value into an opaque black viewport.
    background: theme.isTransparent ? "transparent" : theme.appBg,
    foreground: theme.termForeground,
    cursor: theme.termCursor,
    selectionBackground: theme.termSelection,
    scrollbarSliderBackground: withAlpha(theme.termForeground, 0.24),
    scrollbarSliderHoverBackground: withAlpha(theme.termForeground, 0.4),
    scrollbarSliderActiveBackground: withAlpha(theme.termForeground, 0.5),
    black: light ? theme.termBlack : blendOpaque(theme.appBg, theme.termBlack, 0.4),
    red: theme.termRed,
    green: theme.termGreen,
    yellow: theme.termYellow,
    blue: theme.termBlue,
    magenta: theme.termMagenta,
    cyan: theme.termCyan,
    white: theme.termWhite,
    brightBlack: light
      ? theme.termBrightBlack
      : blendOpaque(theme.appBg, theme.termBrightBlack, 0.4),
    brightRed: theme.termBrightRed,
    brightGreen: theme.termBrightGreen,
    brightYellow: theme.termBrightYellow,
    brightBlue: theme.termBrightBlue,
    brightMagenta: theme.termBrightMagenta,
    brightCyan: theme.termBrightCyan,
    brightWhite: theme.termBrightWhite,
  };
}

export function applyThemeToTerminals(theme: ShepTheme): void {
  const xtermTheme = createTerminalTheme(theme);
  for (const [, entry] of terminalCache) {
    // Skip hidden terminals entirely — setting options.theme on a
    // terminal with display:none corrupts xterm's internal scroll state.
    // Hidden terminals get the theme applied when they become visible
    // (TerminalView's useEffect re-applies the current store theme).
    const el = entry.term.element;
    if (!el || el.offsetParent === null) continue;

    preserveTerminalViewport(entry.term, () => {
      // Dispose WebGL before applying a transparent theme; load WebGL only
      // after an opaque theme is installed. Both transitions complete in the
      // same task, avoiding an intermediate black or opaque frame.
      if (theme.isTransparent) {
        reconcileTerminalRenderer(entry.term, entry, theme);
      }
      entry.term.options.theme = xtermTheme;
      if (!theme.isTransparent) {
        reconcileTerminalRenderer(entry.term, entry, theme);
      }
      entry.term.refresh(0, entry.term.rows - 1);
    });
  }
}

export function applyTerminalSettings(settings: TerminalSettings): void {
  const cssFont = buildCSSFontFamily(settings.fontFamily);

  for (const [ptyId, entry] of terminalCache) {
    const fontMetricsChanged =
      entry.term.options.fontFamily !== cssFont ||
      entry.term.options.fontSize !== settings.fontSize;

    entry.term.options.cursorStyle = settings.cursorStyle;
    entry.term.options.cursorBlink = settings.cursorBlink;
    entry.term.options.scrollback = settings.scrollback;
    entry.term.options.fontFamily = cssFont;
    entry.term.options.fontSize = settings.fontSize;

    const el = entry.term.element;
    if (!fontMetricsChanged || !el || el.offsetParent === null) continue;

    // Clear the renderer's glyph texture atlas so the new font is measured
    // and cached from scratch. Without this, xterm keeps rendering glyphs
    // with the *old* font's metrics, causing clipping and misalignment.
    entry.rendererAddon?.clearTextureAtlas?.();
    preserveTerminalViewport(entry.term, () => {
      entry.fitAddon.fit();
    });
    entry.term.refresh(0, entry.term.rows - 1);
    resizePty(ptyId, entry.term.cols, entry.term.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY after terminal settings change:", error);
      }
    });
  }
}
