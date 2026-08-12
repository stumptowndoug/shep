import { create } from "zustand";
import { getAllUsageSnapshots } from "../lib/tauri";
import type { ProviderUsageSnapshot, UsageProvider } from "../lib/types";

export type TimeWindow = "5h" | "7d" | "30d" | "365d";

interface UsageStore {
  snapshots: Record<string, ProviderUsageSnapshot>;
  loading: boolean;
  error: string | null;
  window: TimeWindow;
  setWindow: (window: TimeWindow) => void;
  sidebarWindow: "5h" | "7d";
  setSidebarWindow: (window: "5h" | "7d") => void;
  fetchSnapshots: () => Promise<void>;
  getSnapshot: (provider: UsageProvider) => ProviderUsageSnapshot | null;
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  snapshots: {},
  loading: false,
  error: null,
  window: "7d",
  setWindow: (window) => set({ window }),
  sidebarWindow: "7d",
  setSidebarWindow: (sidebarWindow) => set({ sidebarWindow }),
  fetchSnapshots: async () => {
    set({ loading: true, error: null });
    try {
      const snapshots = await getAllUsageSnapshots();
      set({
        loading: false,
        snapshots: Object.fromEntries(snapshots.map((snapshot) => [snapshot.provider, snapshot])),
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to fetch usage snapshots",
      });
    }
  },
  getSnapshot: (provider) => get().snapshots[provider] ?? null,
}));
