import { create } from "zustand";

interface UIStore {
  settingsActive: boolean;
  usagePanelActive: boolean;
  portsPanelActive: boolean;
  historyPanelActive: boolean;
  projectsPanelActive: boolean;
  projectSwitcherOpen: boolean;
  sidebarVisible: boolean;
  username: string | null;
  computerName: string | null;
  toggleSettings: () => void;
  toggleUsagePanel: () => void;
  togglePortsPanel: () => void;
  toggleHistoryPanel: () => void;
  toggleProjectsPanel: () => void;
  setProjectSwitcherOpen: (open: boolean) => void;
  deactivateAllOverlays: () => void;
  toggleSidebar: () => void;
  setUsername: (name: string) => void;
  setComputerName: (name: string) => void;
}

const deactivateAll = {
  settingsActive: false,
  usagePanelActive: false,
  portsPanelActive: false,
  historyPanelActive: false,
  projectsPanelActive: false,
};

export const useUIStore = create<UIStore>((set) => ({
  settingsActive: false,
  usagePanelActive: false,
  portsPanelActive: false,
  historyPanelActive: false,
  projectsPanelActive: false,
  projectSwitcherOpen: false,
  sidebarVisible: true,
  username: null,
  computerName: null,
  toggleSettings: () =>
    set((s) => {
      if (s.settingsActive) return { settingsActive: false };
      return { ...deactivateAll, settingsActive: true };
    }),
  toggleUsagePanel: () =>
    set((s) => {
      if (s.usagePanelActive) return { usagePanelActive: false };
      return { ...deactivateAll, usagePanelActive: true };
    }),
  togglePortsPanel: () =>
    set((s) => {
      if (s.portsPanelActive) return { portsPanelActive: false };
      return { ...deactivateAll, portsPanelActive: true };
    }),
  toggleHistoryPanel: () =>
    set((s) => {
      if (s.historyPanelActive) return { historyPanelActive: false };
      return { ...deactivateAll, historyPanelActive: true };
    }),
  toggleProjectsPanel: () =>
    set((s) => {
      if (s.projectsPanelActive) return { projectsPanelActive: false };
      return { ...deactivateAll, projectsPanelActive: true, projectSwitcherOpen: false };
    }),
  setProjectSwitcherOpen: (open: boolean) => set({ projectSwitcherOpen: open }),
  deactivateAllOverlays: () => set(deactivateAll),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setUsername: (name: string) => set({ username: name }),
  setComputerName: (name: string) => set({ computerName: name }),
}));
