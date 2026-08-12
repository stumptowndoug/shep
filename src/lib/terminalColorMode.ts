import { hexLuminance } from "./themes.ts";
import type { ShepTheme } from "./themes.ts";

const LIGHT_THEME_LUMINANCE_THRESHOLD = 0.3;
const CURSOR_LIGHT_MINIMUM_CONTRAST = 4.5;

export function isLightTerminalTheme(theme: ShepTheme): boolean {
  return hexLuminance(theme.appBg) > LIGHT_THEME_LUMINANCE_THRESHOLD;
}

export function terminalColorEnvironment(
  theme: ShepTheme,
): Record<string, string> {
  const light = isLightTerminalTheme(theme);
  return {
    COLORFGBG: light ? "0;15" : "15;0",
    // Cursor reads TERM_THEME before its terminal-query subscription is ready.
    TERM_THEME: light ? "light" : "dark",
  };
}

export function terminalMinimumContrastRatio(
  theme: ShepTheme,
  assistantId: string | null,
): number {
  return assistantId === "cursor" && isLightTerminalTheme(theme)
    ? CURSOR_LIGHT_MINIMUM_CONTRAST
    : 1;
}

export function shouldSuppressCursorDim(
  theme: ShepTheme,
  assistantId: string | null,
  params: (number | number[])[],
): boolean {
  // Cursor emits standalone SGR 2 sequences for most secondary UI text.
  // Suppress only that exact command in Cursor's light mode so combined SGR
  // sequences and every other terminal keep normal xterm behavior.
  return assistantId === "cursor"
    && isLightTerminalTheme(theme)
    && params.length === 1
    && params[0] === 2;
}
