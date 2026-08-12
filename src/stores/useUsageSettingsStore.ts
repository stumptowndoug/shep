import { create } from "zustand";
import { getUsageSettings, saveUsageSettings } from "../lib/tauri";
import type { UsageSettings, UsageProvider, ProviderBudgetConfig } from "../lib/types";

const DEFAULT_SETTINGS: UsageSettings = {
  claude: { show: true, budgetMode: "subscription", monthlyBudget: null },
  codex: { show: true, budgetMode: "subscription", monthlyBudget: null },
  antigravity: { show: true, budgetMode: "subscription", monthlyBudget: null },
  gemini: { show: false, budgetMode: "subscription", monthlyBudget: null },
  opencode: { show: true, budgetMode: "custom", monthlyBudget: 100 },
  pi: { show: false, budgetMode: "custom", monthlyBudget: null },
  grok: { show: true, budgetMode: "subscription", monthlyBudget: null },
};

interface UsageSettingsStore {
  settings: UsageSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateProvider: (provider: UsageProvider, patch: Partial<ProviderBudgetConfig>) => Promise<void>;
  isProviderEnabled: (provider: UsageProvider) => boolean;
  getProviderConfig: (provider: UsageProvider) => ProviderBudgetConfig;
}

export const useUsageSettingsStore = create<UsageSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
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
  updateProvider: async (provider, patch) => {
    const prev = get().settings;
    const next = { ...prev, [provider]: { ...prev[provider], ...patch } };
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
  isProviderEnabled: (provider) => get().settings[provider].show,
  getProviderConfig: (provider) => get().settings[provider],
}));
