import { create } from "zustand";
import type { AgentStatusObservation, TerminalTabData, TabActivity, UnifiedTab, PanelTabKind, PanelTabData } from "../lib/types";
import { panelTabId, panelTabDefaults } from "../lib/types";
import { nextAgentDoneState } from "../lib/agentActivity";
import { useUIStore } from "./useUIStore";

interface ProjectTerminalState {
  tabs: UnifiedTab[];
  activeTabId: string | null;
}

interface TerminalStore {
  projectState: Record<string, ProjectTerminalState>;
  activeProjectPath: string | null;
  tabActivity: Record<number, TabActivity>;
  switchProject: (repoPath: string) => void;
  removeProject: (repoPath: string) => void;
  addTab: (tab: UnifiedTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Pick<UnifiedTab, "label">>) => void;
  setTabTitleFromPty: (ptyId: number, title: string) => void;
  setTabSessionInfo: (ptyId: number, sessionId: string, title: string | null) => void;
  reorderTab: (tabId: string, toIndex: number) => void;
  addPanelTab: (kind: PanelTabKind) => void;
  removePanelTab: (kind: PanelTabKind) => void;
  togglePanelTab: (kind: PanelTabKind) => void;
  findTabByCommand: (commandName: string) => TerminalTabData | undefined;
  findTabByPtyId: (ptyId: number) => TerminalTabData | undefined;
  initActivity: (ptyId: number) => void;
  setTabActive: (ptyId: number, active: boolean) => void;
  setTabAgentState: (ptyId: number, observation: AgentStatusObservation | null) => void;
  setTabExited: (ptyId: number, exitCode: number) => void;
  setTabBell: (ptyId: number, message?: string) => void;
  clearTabBell: (ptyId: number) => void;
  removeActivity: (ptyId: number) => void;
  getAllProjectTabs: (repoPath: string) => UnifiedTab[];
}

function emptyState(): ProjectTerminalState {
  return { tabs: [], activeTabId: null };
}

let tabCounter = 0;
export function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

function normalizeTerminalTitle(title: string): string | null {
  const normalized = title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return [...normalized].slice(0, 160).join("");
}

function projectName(repoPath: string): string {
  return repoPath.split("/").filter(Boolean).pop() ?? repoPath;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function usefulPtyTitle(tab: TerminalTabData, title: string): string | null {
  const project = projectName(tab.repoPath);

  if (tab.assistantId === "claude") {
    // Claude prefixes its OSC title with `*` while it is actively working.
    // Keep that transient status marker out of the persistent tab label.
    return normalizeTerminalTitle(title.replace(/^\*+\s*/, ""));
  }

  if (tab.assistantId === "pi") {
    const prefix = "π - ";
    if (title === `${prefix}${project}`) return null;
    if (title.startsWith(prefix) && title.endsWith(` - ${project}`)) {
      return normalizeTerminalTitle(title.slice(prefix.length, -(project.length + 3)));
    }
  }

  if (tab.assistantId === "codex") {
    const withoutSpinner = title.replace(/^[\u2800-\u28ff]+\s*/, "");
    if (withoutSpinner === project) return null;
    if (withoutSpinner.endsWith(` | ${project}`)) {
      const thread = withoutSpinner.slice(0, -(project.length + 3)).trim();
      return thread && !isUuid(thread) ? thread : null;
    }
  }

  return title;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  projectState: {},
  activeProjectPath: null,
  tabActivity: {},

  switchProject: (repoPath: string) => {
    set((state) => {
      if (state.projectState[repoPath]) {
        const project = state.projectState[repoPath];
        const activeTab = project.tabs.find((tab) => tab.id === project.activeTabId);
        if (
          activeTab &&
          (activeTab.kind === "terminal" || activeTab.kind === "assistant") &&
          state.tabActivity[activeTab.ptyId]?.agentDone
        ) {
          return {
            activeProjectPath: repoPath,
            tabActivity: {
              ...state.tabActivity,
              [activeTab.ptyId]: {
                ...state.tabActivity[activeTab.ptyId],
                agentDone: false,
              },
            },
          };
        }
        return { activeProjectPath: repoPath };
      }
      return {
        projectState: { ...state.projectState, [repoPath]: emptyState() },
        activeProjectPath: repoPath,
      };
    });
  },

  removeProject: (repoPath: string) => {
    set((state) => {
      const projectState = { ...state.projectState };
      const project = projectState[repoPath];
      delete projectState[repoPath];

      const tabActivity = { ...state.tabActivity };
      if (project) {
        for (const tab of project.tabs) {
          if (tab.kind === "terminal" || tab.kind === "assistant") {
            delete tabActivity[tab.ptyId];
          }
        }
      }

      return {
        projectState,
        tabActivity,
        ...(state.activeProjectPath === repoPath
          ? { activeProjectPath: null }
          : {}),
      };
    });
  },

  addTab: (tab: UnifiedTab) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path] ?? emptyState();
      return {
        projectState: {
          ...state.projectState,
          [path]: {
            tabs: [...ps.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
  },

  removeTab: (id: string) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps) return state;
      const closedIndex = ps.tabs.findIndex((t) => t.id === id);
      if (closedIndex === -1) return state;
      const tabs = ps.tabs.filter((t) => t.id !== id);
      let activeTabId = ps.activeTabId;
      if (ps.activeTabId === id) {
        if (tabs.length === 0) {
          activeTabId = null;
        } else {
          activeTabId = tabs[Math.min(closedIndex, tabs.length - 1)].id;
        }
      }
      return {
        projectState: {
          ...state.projectState,
          [path]: { tabs, activeTabId },
        },
      };
    });
  },

  setActiveTab: (id: string) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps || !ps.tabs.some((t) => t.id === id)) return state;
      const tab = ps.tabs.find((candidate) => candidate.id === id);
      const clearDone = tab &&
        (tab.kind === "terminal" || tab.kind === "assistant") &&
        state.tabActivity[tab.ptyId]?.agentDone;
      return {
        projectState: {
          ...state.projectState,
          [path]: { ...ps, activeTabId: id },
        },
        ...(clearDone
          ? {
              tabActivity: {
                ...state.tabActivity,
                [tab.ptyId]: {
                  ...state.tabActivity[tab.ptyId],
                  agentDone: false,
                },
              },
            }
          : {}),
      };
    });
  },

  updateTab: (id: string, patch: Partial<Pick<UnifiedTab, "label">>) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps) return state;
      return {
        projectState: {
          ...state.projectState,
          [path]: {
            ...ps,
            tabs: ps.tabs.map((t) => {
              if (t.id !== id) return t;
              if (t.kind === "terminal" || t.kind === "assistant") {
                return { ...t, ...patch, labelSource: "user" as const };
              }
              return { ...t, ...patch };
            }),
          },
        },
      };
    });
  },

  setTabTitleFromPty: (ptyId: number, title: string) => {
    const normalized = normalizeTerminalTitle(title);
    if (!normalized) return;

    set((state) => {
      for (const [path, project] of Object.entries(state.projectState)) {
        const index = project.tabs.findIndex(
          (tab) =>
            (tab.kind === "terminal" || tab.kind === "assistant") &&
            tab.ptyId === ptyId,
        );
        if (index === -1) continue;

        const tab = project.tabs[index];
        if (
          (tab.kind !== "terminal" && tab.kind !== "assistant") ||
          tab.labelSource === "user"
        ) {
          return state;
        }

        const usefulTitle = usefulPtyTitle(tab, normalized);
        if (!usefulTitle || tab.label === usefulTitle) return state;
        // Resolved metadata is more stable than transient OSC titles. Pi's
        // named OSC form is the exception because it represents an explicit
        // `/name`, while Pi's generic project title was filtered above.
        if (tab.labelSource === "session" && tab.assistantId !== "pi") {
          return state;
        }

        const tabs = [...project.tabs];
        tabs[index] = { ...tab, label: usefulTitle, labelSource: "terminal" };
        return {
          projectState: {
            ...state.projectState,
            [path]: { ...project, tabs },
          },
        };
      }
      return state;
    });
  },

  setTabSessionInfo: (ptyId: number, sessionId: string, title: string | null) => {
    const normalized = title ? normalizeTerminalTitle(title) : null;
    set((state) => {
      for (const [path, project] of Object.entries(state.projectState)) {
        const index = project.tabs.findIndex(
          (tab) =>
            (tab.kind === "terminal" || tab.kind === "assistant") &&
            tab.ptyId === ptyId,
        );
        if (index === -1) continue;

        const tab = project.tabs[index];
        if (
          tab.kind !== "terminal" && tab.kind !== "assistant"
        ) {
          return state;
        }

        const tabs = [...project.tabs];
        tabs[index] = {
          ...tab,
          providerSessionId: sessionId,
          ...(normalized && tab.labelSource !== "user" && tab.label !== normalized
            ? { label: normalized, labelSource: "session" as const }
            : {}),
        };
        return {
          projectState: {
            ...state.projectState,
            [path]: { ...project, tabs },
          },
        };
      }
      return state;
    });
  },

  reorderTab: (tabId: string, toIndex: number) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps) return state;
      const fromIndex = ps.tabs.findIndex((t) => t.id === tabId);
      if (fromIndex === -1) return state;

      const boundedIndex = Math.max(0, Math.min(toIndex, ps.tabs.length));
      const targetIndex = boundedIndex > fromIndex ? boundedIndex - 1 : boundedIndex;
      if (fromIndex === targetIndex) return state;

      const tabs = [...ps.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(targetIndex, 0, moved);
      return {
        projectState: {
          ...state.projectState,
          [path]: { ...ps, tabs },
        },
      };
    });
  },

  addPanelTab: (kind: PanelTabKind) => {
    useUIStore.getState().deactivateAllOverlays();
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path] ?? emptyState();
      const id = panelTabId(kind);
      const existing = ps.tabs.find((t) => t.id === id);
      if (existing) {
        return {
          projectState: {
            ...state.projectState,
            [path]: { ...ps, activeTabId: id },
          },
        };
      }
      const tab: PanelTabData = { id, kind, label: panelTabDefaults[kind].label };
      return {
        projectState: {
          ...state.projectState,
          [path]: { tabs: [...ps.tabs, tab], activeTabId: id },
        },
      };
    });
  },

  removePanelTab: (kind: PanelTabKind) => {
    get().removeTab(panelTabId(kind));
  },

  togglePanelTab: (kind: PanelTabKind) => {
    const state = get();
    const path = state.activeProjectPath;
    if (!path) return;
    const ps = state.projectState[path];
    const id = panelTabId(kind);
    const existing = ps?.tabs.find((t) => t.id === id);
    if (existing && ps?.activeTabId === id) {
      get().removeTab(id);
    } else if (existing) {
      useUIStore.getState().deactivateAllOverlays();
      set((s) => {
        const p = s.projectState[path];
        if (!p) return s;
        return {
          projectState: { ...s.projectState, [path]: { ...p, activeTabId: id } },
        };
      });
    } else {
      get().addPanelTab(kind);
    }
  },

  findTabByCommand: (commandName: string) => {
    const state = get();
    if (!state.activeProjectPath) return undefined;
    const ps = state.projectState[state.activeProjectPath];
    return ps?.tabs.find(
      (t): t is TerminalTabData => (t.kind === "terminal" || t.kind === "assistant") && t.commandName === commandName,
    );
  },

  findTabByPtyId: (ptyId: number) => {
    const state = get();
    for (const project of Object.values(state.projectState)) {
      const tab = project.tabs.find(
        (candidate): candidate is TerminalTabData =>
          (candidate.kind === "terminal" || candidate.kind === "assistant") &&
          candidate.ptyId === ptyId,
      );
      if (tab) return tab;
    }
    return undefined;
  },

  initActivity: (ptyId: number) => {
    set((state) => ({
      tabActivity: {
        ...state.tabActivity,
        [ptyId]: {
          alive: true,
          active: true,
          exitCode: null,
          bell: false,
          lastOutputAt: Date.now(),
          lastAttentionAt: null,
          lastNotificationMessage: null,
          agentState: null,
          agentStatusUpdatedAt: null,
          agentStatusSource: null,
          agentStatusReason: null,
          agentStatusRuleId: null,
          agentDone: false,
        },
      },
    }));
  },

  setTabActive: (ptyId: number, active: boolean) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev || prev.active === active) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            active,
            lastOutputAt: active || prev.active ? Date.now() : prev.lastOutputAt,
          },
        },
      };
    });
  },

  setTabAgentState: (ptyId: number, observation: AgentStatusObservation | null) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      const agentState = observation?.state ?? null;
      const statusUpdatedAt = observation?.updatedAt ?? null;
      const statusSource = observation?.source ?? null;
      const statusReason = observation?.reason ?? null;
      const statusRuleId = observation?.ruleId ?? null;
      let isViewed = false;
      for (const [path, project] of Object.entries(state.projectState)) {
        const tab = project.tabs.find(
          (candidate) =>
            (candidate.kind === "terminal" || candidate.kind === "assistant") &&
            candidate.ptyId === ptyId,
        );
        if (tab) {
          isViewed = path === state.activeProjectPath && tab.id === project.activeTabId;
          break;
        }
      }
      const agentDone = nextAgentDoneState(
        prev.agentState,
        prev.agentDone,
        agentState,
        isViewed,
      );
      if (
        prev.agentState === agentState &&
          prev.agentStatusUpdatedAt === statusUpdatedAt &&
          prev.agentStatusSource === statusSource &&
          prev.agentStatusReason === statusReason &&
          prev.agentStatusRuleId === statusRuleId &&
          prev.agentDone === agentDone
      ) {
        return state;
      }
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            agentState,
            agentStatusUpdatedAt: statusUpdatedAt,
            agentStatusSource: statusSource,
            agentStatusReason: statusReason,
            agentStatusRuleId: statusRuleId,
            agentDone,
          },
        },
      };
    });
  },

  setTabExited: (ptyId: number, exitCode: number) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            alive: false,
            exitCode,
            agentState: null,
            agentStatusUpdatedAt: null,
            agentStatusSource: null,
            agentStatusReason: null,
            agentStatusRuleId: null,
            agentDone: false,
          },
        },
      };
    });
  },

  setTabBell: (ptyId: number, message?: string) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            bell: true,
            lastAttentionAt: Date.now(),
            lastNotificationMessage: message?.trim() || prev.lastNotificationMessage,
          },
        },
      };
    });
  },

  clearTabBell: (ptyId: number) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return { tabActivity: { ...state.tabActivity, [ptyId]: { ...prev, bell: false } } };
    });
  },

  removeActivity: (ptyId: number) => {
    set((state) => {
      const { [ptyId]: _, ...rest } = state.tabActivity;
      return { tabActivity: rest };
    });
  },

  getAllProjectTabs: (repoPath: string) => {
    const ps = get().projectState[repoPath];
    return ps?.tabs ?? [];
  },
}));
