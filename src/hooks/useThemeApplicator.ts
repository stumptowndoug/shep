import { useEffect } from "react";
import { getCurrentWindow, Effect, EffectState } from "@tauri-apps/api/window";
import { isWindows } from "../lib/platform";
import { useThemeStore } from "../stores/useThemeStore";
import { applyThemeToTerminals } from "../components/terminal/terminalTheme";
import { hexLuminance } from "../lib/themes";
import type { ShepTheme } from "../lib/themes";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { updatePtyColorTheme } from "../lib/tauri";

const CSS_VAR_MAP: [keyof ShepTheme, string][] = [
  ["appBg", "--app-bg"],
  ["appFg", "--app-fg"],
  ["bgRadial1", "--bg-radial-1"],
  ["bgRadial2", "--bg-radial-2"],
  ["bgRadial3", "--bg-radial-3"],
  ["bgLinearFrom", "--bg-linear-from"],
  ["bgLinearMid", "--bg-linear-mid"],
  ["bgLinearTo", "--bg-linear-to"],
  ["frameTint", "--frame-tint"],
  ["panelTint", "--panel-tint"],
  ["glassBorder", "--glass-border"],
  ["glassPanelStrong", "--glass-panel-strong"],
  ["glassBorderStrong", "--glass-border-strong"],
  ["statusRunning", "--status-running"],
  ["statusStopped", "--status-stopped"],
  ["statusCrashed", "--status-crashed"],
  ["statusAttention", "--status-attention"],
  ["termGreen", "--status-clean"],
  ["termGreen", "--diff-add"],
  ["termRed", "--diff-del"],
  ["termMagenta", "--diff-hunk"],
  ["termGreen", "--status-added"],
  ["termRed", "--status-deleted"],
];

export function useThemeApplicator(): void {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const style = document.documentElement.style;
    for (const [key, cssVar] of CSS_VAR_MAP) {
      style.setProperty(cssVar, theme[key] as string);
    }

    // Overlay color: white for dark themes, black for light themes
    const isLight = hexLuminance(theme.appBg) > 0.3;
    style.setProperty("--overlay", isLight ? "#000000" : "#ffffff");
    style.setProperty("--bg-mix-edge", isLight ? "8%" : "30%");
    style.setProperty("--bg-mix-mid", isLight ? "4%" : "20%");
    document.documentElement.style.setProperty(
      "color-scheme",
      isLight ? "light" : "dark",
    );
    document.documentElement.dataset.themeTone = isLight ? "light" : "dark";

    applyThemeToTerminals(theme);
    updatePtyColorTheme(toPtyColorTheme(theme)).catch(() => {});

    const win = getCurrentWindow();
    if (theme.isTransparent) {
      document.body.classList.add("theme-clear");
      // HudWindow is an NSVisualEffectView material (macOS); Windows gets the
      // DWM equivalents — Tauri applies the first effect the OS supports.
      win.setEffects({
        effects: isWindows ? [Effect.Acrylic, Effect.Blur] : [Effect.HudWindow],
        state: EffectState.Active,
      });
    } else {
      document.body.classList.remove("theme-clear");
      win.clearEffects();
    }
  }, [theme]);
}
