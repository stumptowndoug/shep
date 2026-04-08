import { create } from "zustand";
import type { TerminalSettings } from "../lib/types";
import { getTerminalSettings, saveTerminalSettings } from "../lib/tauri";
import { applyTerminalSettings } from "../components/terminal/terminalTheme";

import { normalizeTerminalFontFamily, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "../lib/terminalConfig";
import { loadCustomFont } from "../lib/fontLoader";

const DEFAULT_SETTINGS: TerminalSettings = {
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: TERMINAL_FONT_SIZE,
};

interface TerminalSettingsStore {
  settings: TerminalSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
}

export const useTerminalSettingsStore = create<TerminalSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

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
}));
