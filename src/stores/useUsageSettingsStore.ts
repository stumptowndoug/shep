import { create } from "zustand";
import { getUsageSettings, saveUsageSettings } from "../lib/tauri";
import type { UsageSettings, UsageProvider } from "../lib/types";

interface UsageSettingsStore {
  settings: UsageSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  setProviderEnabled: (provider: UsageProvider, enabled: boolean) => Promise<void>;
  isProviderEnabled: (provider: UsageProvider) => boolean;
}

const KEY_MAP: Record<UsageProvider, keyof UsageSettings> = {
  claude: "showClaude",
  codex: "showCodex",
  gemini: "showGemini",
  opencode: "showOpencode",
};

export const useUsageSettingsStore = create<UsageSettingsStore>((set, get) => ({
  settings: { showClaude: true, showCodex: true, showGemini: true, showOpencode: true },
  hasLoaded: false,
  isSaving: false,
  error: null,
  loadSettings: async () => {
    try {
      const settings = await getUsageSettings();
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({
        hasLoaded: true,
        error: error instanceof Error ? error.message : "Failed to load usage settings",
      });
    }
  },
  setProviderEnabled: async (provider, enabled) => {
    const prev = get().settings;
    const key = KEY_MAP[provider];
    const next = { ...prev, [key]: enabled };
    set({ settings: next, isSaving: true });
    try {
      await saveUsageSettings(next);
      set({ isSaving: false, error: null });
    } catch (error) {
      set({
        settings: prev,
        isSaving: false,
        error: error instanceof Error ? error.message : "Failed to save usage settings",
      });
    }
  },
  isProviderEnabled: (provider) => {
    const key = KEY_MAP[provider];
    return get().settings[key];
  },
}));
