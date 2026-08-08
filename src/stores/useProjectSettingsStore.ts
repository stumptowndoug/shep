import { create } from "zustand";
import type { ProjectSettings } from "../lib/types";
import { getProjectSettings, saveProjectSettings } from "../lib/tauri";

const DEFAULT_SETTINGS: ProjectSettings = {
  autoImportWorktrees: true,
  agentLabelMode: "repository",
  defaultAgentMode: "yolo",
  showTodos: true,
  todoFileStyle: "kanban",
};

interface ProjectSettingsStore {
  settings: ProjectSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<ProjectSettings>) => Promise<void>;
}

export const useProjectSettingsStore = create<ProjectSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await getProjectSettings();
      set({
        settings: {
          ...settings,
          defaultAgentMode: settings.defaultAgentMode === "standard" ? "standard" : "yolo",
        },
        hasLoaded: true,
        error: null,
      });
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  updateSettings: async (partial) => {
    const prev = get().settings;
    const next = { ...prev, ...partial };
    set({ settings: next, isSaving: true, error: null });
    try {
      await saveProjectSettings(next);
      set({ isSaving: false, hasLoaded: true });
    } catch (error) {
      set({ settings: prev, isSaving: false, error: String(error) });
    }
  },
}));
