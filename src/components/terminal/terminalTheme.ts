import type { ITheme } from "@xterm/xterm";
import { hexLuminance } from "../../lib/themes";
import type { ShepTheme } from "../../lib/themes";
import type { TerminalSettings } from "../../lib/types";
import { resizePty } from "../../lib/tauri";
import { terminalCache } from "./TerminalView";

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

export function createTerminalTheme(theme: ShepTheme): ITheme {
  const light = isLightTheme(theme);
  return {
    background: "transparent",
    foreground: theme.termForeground,
    cursor: theme.termCursor,
    selectionBackground: theme.termSelection,
    black: light ? theme.termBlack : withAlpha(theme.termBlack, 0.4),
    red: theme.termRed,
    green: theme.termGreen,
    yellow: theme.termYellow,
    blue: theme.termBlue,
    magenta: theme.termMagenta,
    cyan: theme.termCyan,
    white: theme.termWhite,
    brightBlack: light ? theme.termBrightBlack : withAlpha(theme.termBrightBlack, 0.4),
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

    entry.term.options.theme = xtermTheme;
    entry.term.refresh(0, entry.term.rows - 1);
  }
}

export function applyTerminalSettings(settings: TerminalSettings): void {
  for (const [ptyId, entry] of terminalCache) {
    const fontMetricsChanged =
      entry.term.options.fontFamily !== settings.fontFamily ||
      entry.term.options.fontSize !== settings.fontSize;

    entry.term.options.cursorStyle = settings.cursorStyle;
    entry.term.options.cursorBlink = settings.cursorBlink;
    entry.term.options.scrollback = settings.scrollback;
    entry.term.options.fontFamily = settings.fontFamily;
    entry.term.options.fontSize = settings.fontSize;

    const el = entry.term.element;
    if (!fontMetricsChanged || !el || el.offsetParent === null) continue;

    // Force the renderer to discard cached glyphs so they are re-drawn
    // with the new font/size.  Without this the CanvasAddon (or WebGL)
    // texture atlas keeps stale glyphs rendered in the previous font.
    entry.term.clearTextureAtlas();

    entry.fitAddon.fit();
    entry.term.refresh(0, entry.term.rows - 1);
    resizePty(ptyId, entry.term.cols, entry.term.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY after terminal settings change:", error);
      }
    });
  }
}
