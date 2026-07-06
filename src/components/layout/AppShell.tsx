import { Suspense, lazy, useEffect, useCallback, useRef, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "../sidebar/Sidebar";
import TabBar from "./TabBar";
import TerminalView from "../terminal/TerminalView";
import TerminalErrorBoundary from "../terminal/TerminalErrorBoundary";
import NoticeCenter from "../shared/NoticeCenter";
import { Minus, PanelLeft, PanelRight, Square, X } from "lucide-react";
import { useRepoStore } from "../../stores/useRepoStore";
import { useCommandStore } from "../../stores/useCommandStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useTodoStore } from "../../stores/useTodoStore";
import { useSkillStore } from "../../stores/useSkillStore";
import { useUIStore } from "../../stores/useUIStore";
import { useShallow } from "zustand/shallow";
import { usePty } from "../../hooks/usePty";
import { useThemeApplicator } from "../../hooks/useThemeApplicator";
import { useGitWatcher } from "../../hooks/useGitWatcher";
import { computeTerminalSize } from "../../lib/terminalMeasure";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { getUsername, getComputerName, openInEditor, saveWorkspace, shutdownAndQuit, refreshUsageData } from "../../lib/tauri";
import { useEditorStore } from "../../stores/useEditorStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { useUsageStore } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUpdateStore } from "../../stores/useUpdateStore";
import { initNotifications } from "../../lib/notifications";
import { getErrorMessage } from "../../lib/errors";
import { isWindows, modKeyLabel } from "../../lib/platform";
import { pathBasename } from "../../lib/paths";
import { useNoticeStore } from "../../stores/useNoticeStore";

import type { CommandConfig, CommandState, TerminalTabData, UnifiedTab, SessionMode, WorkspaceConfig } from "../../lib/types";
const LAST_REPO_STORAGE_KEY = "shep:last-repo-path";

// Stable empty arrays to avoid infinite re-render loops with zustand v5's
// useSyncExternalStore — selectors must return the same reference for the same state.
const EMPTY_TABS: UnifiedTab[] = [];
const EMPTY_COMMANDS: CommandState[] = [];
const SettingsPanel = lazy(() => import("../settings/SettingsPanel"));
const GitPanel = lazy(() => import("../git/GitPanel"));
const CommandsPanel = lazy(() => import("../commands/CommandsPanel"));
const SessionLauncher = lazy(() => import("../session/SessionLauncher"));
const UsagePanel = lazy(() => import("../usage/UsagePanel"));
const PortsPanel = lazy(() => import("../ports/PortsPanel"));
const DiffSummaryPanel = lazy(() => import("../git/DiffSummaryPanel"));
const TodosPanel = lazy(() => import("../todos/TodosPanel"));

function toCommandConfig(command: CommandState): CommandConfig {
  return {
    name: command.name,
    command: command.command,
    autostart: command.autostart,
    env: command.env,
    cwd: command.cwd,
  };
}

function fallbackWorkspaceName(repoPath: string) {
  return pathBasename(repoPath) || "Project";
}

function PanelLoader() {
  return <div className="terminal-empty">Loading panel…</div>;
}

export default function AppShell() {
  useThemeApplicator();

  const { repos, groups, activeRepoPath, fetchRepos, fetchGroups, openRepo, addRepo, removeRepo, renameGroup, deleteGroup, moveRepoToGroup } =
    useRepoStore();
  const activeConfig = useRepoStore((s) => s.activeConfig);
  const setActiveConfig = useRepoStore((s) => s.setActiveConfig);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const { startCommand, stopCommand, spawnBlankShell, launchAssistant, closeTab, killProjectPtys } =
    usePty();

  const restoreAttemptedRef = useRef(false);
  const terminalContainerRef = useRef<HTMLDivElement>(null);

  const getTerminalDimensions = useCallback(() => {
    const el = terminalContainerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) {
      return { cols: 80, rows: 24 };
    }
    return computeTerminalSize(el.clientWidth, el.clientHeight);
  }, []);

  // Derive active project's tabs and commands from stores
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const activeProjectTerminals = useTerminalStore(
    (s) => (s.activeProjectPath ? s.projectState[s.activeProjectPath] : null),
  );
  const tabs = activeProjectTerminals?.tabs ?? EMPTY_TABS;
  const activeTabId = activeProjectTerminals?.activeTabId ?? null;
  // Derive allTabs via useMemo instead of a selector that returns a new array
  // every call — zustand v5 + useSyncExternalStore would infinite-loop otherwise.
  const projectState = useTerminalStore((s) => s.projectState);

  // Git watching: main repo paths only — worktree paths are discovered automatically
  const gitRepoPaths = useMemo(
    () => repos.map((r) => r.path),
    [repos],
  );
  useGitWatcher(gitRepoPaths);
  // Collect only PTY-backed tabs for TerminalView rendering (panel tabs have no terminal)
  const allTerminalTabs = useMemo(() => {
    const all: TerminalTabData[] = [];
    for (const ps of Object.values(projectState)) {
      for (const tab of ps.tabs) {
        if (tab.kind === "terminal" || tab.kind === "assistant") {
          all.push(tab);
        }
      }
    }

    // Keep terminal DOM order stable even when the visible tab order changes.
    // xterm renderers can fail to repaint cleanly when their mounted nodes are
    // shuffled around in the document during tab drag/reorder operations.
    return all.sort((a, b) => a.ptyId - b.ptyId || a.id.localeCompare(b.id));
  }, [projectState]);

  const commands = useCommandStore(
    (s) => (s.activeProjectPath ? s.projectCommands[s.activeProjectPath] ?? EMPTY_COMMANDS : EMPTY_COMMANDS),
  );

  const { setActiveTab } = useTerminalStore.getState();

  const persistWorkspaceCommands = useCallback(
    async (nextCommands: CommandConfig[]) => {
      if (!activeRepoPath) return null;

      const nextConfig: WorkspaceConfig = {
        name: activeConfig?.name ?? fallbackWorkspaceName(activeRepoPath),
        assistants: activeConfig?.assistants ?? [],
        commands: nextCommands,
      };

      try {
        await saveWorkspace(activeRepoPath, nextConfig);
        setActiveConfig(nextConfig);
        return nextConfig;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("Failed to save workspace commands:", error);
        }
        pushNotice({
          tone: "error",
          title: "Couldn’t save workspace",
          message: getErrorMessage(error),
        });
        return null;
      }
    },
    [activeConfig, activeRepoPath, pushNotice, setActiveConfig],
  );

  const {
    settingsActive, usagePanelActive, portsPanelActive, sidebarVisible, diffPanelVisible,
  } = useUIStore(useShallow((s) => ({
    settingsActive: s.settingsActive,
    usagePanelActive: s.usagePanelActive,
    portsPanelActive: s.portsPanelActive,
    sidebarVisible: s.sidebarVisible,
    diffPanelVisible: s.diffPanelVisible,
  })));

  // Derive which kind of local tab is active (for panel content rendering)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const { loadSettings: loadEditorSettings } = useEditorStore.getState();
  const { loadSettings: loadTerminalSettings } = useTerminalSettingsStore.getState();
  const { fetchSnapshots: fetchUsageSnapshots } = useUsageStore.getState();
  const { loadSettings: loadUsageSettings } = useUsageSettingsStore.getState();

  useEffect(() => {
    fetchRepos();
    fetchGroups();
    void loadEditorSettings();
    void loadTerminalSettings();
    void loadUsageSettings();
    void fetchUsageSnapshots();
    const usageRefreshTimer = window.setTimeout(() => {
      void fetchUsageSnapshots();
    }, 3000);
    void refreshUsageData();
    void initNotifications();
    getUsername().then((name) => useUIStore.getState().setUsername(name));
    getComputerName().then((name) => useUIStore.getState().setComputerName(name));

    // Check for updates after startup settles
    const updateTimer = window.setTimeout(async () => {
      await useUpdateStore.getState().checkForUpdate();
      const { status, availableVersion } = useUpdateStore.getState();
      if (status === "available" && availableVersion) {
        pushNotice(
          { tone: "info", title: "Update available", message: `Version ${availableVersion} is ready to download` },
          { durationMs: 8000 },
        );
      }
    }, 3000);
    return () => {
      window.clearTimeout(updateTimer);
      window.clearTimeout(usageRefreshTimer);
    };
  }, [fetchRepos, fetchGroups, loadEditorSettings, loadTerminalSettings, loadUsageSettings, fetchUsageSnapshots, pushNotice]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshUsageData();
      void fetchUsageSnapshots();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [fetchUsageSnapshots]);

  // Auto-refresh when background ingest completes
  useEffect(() => {
    const unlisten = listen("usage-ingest-complete", () => {
      void fetchUsageSnapshots();
    });
    return () => { unlisten.then((f) => f()); };
  }, [fetchUsageSnapshots]);

  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (repoPath === activeRepoPath) return;

      try {
        const isFirstVisit = !useCommandStore.getState().hasProject(repoPath);

        useUIStore.getState().deactivateAllOverlays();
        const config = await openRepo(repoPath);
        restoreAttemptedRef.current = true;
        window.localStorage.setItem(LAST_REPO_STORAGE_KEY, repoPath);
        useTerminalStore.getState().switchProject(repoPath);
        useCommandStore.getState().switchProject(repoPath);
        void useGitStore.getState().refreshStatus(repoPath);
        if (isFirstVisit) {
          useCommandStore.getState().loadCommands(repoPath, config.commands);

          for (const cmd of config.commands) {
            if (cmd.autostart) {
              const { cols, rows } = getTerminalDimensions();
              await startCommand(cmd, cols, rows);
            }
          }
        }
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t open project",
          message: getErrorMessage(error),
        });
      }
    },
    [activeRepoPath, openRepo, startCommand, getTerminalDimensions, pushNotice],
  );

  const handleAddProject = useCallback(
    async (repoPath: string) => {
      try {
        useUIStore.getState().deactivateAllOverlays();
        const config = await addRepo(repoPath);
        // addRepo sets activeRepoPath in the repo store, get the canonical path
        const canonicalPath = useRepoStore.getState().activeRepoPath;
        if (!canonicalPath) return;
        restoreAttemptedRef.current = true;
        window.localStorage.setItem(LAST_REPO_STORAGE_KEY, canonicalPath);
        useTerminalStore.getState().switchProject(canonicalPath);
        useCommandStore.getState().switchProject(canonicalPath);
        useCommandStore.getState().loadCommands(canonicalPath, config.commands);
        void useGitStore.getState().refreshStatus(canonicalPath);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t add project",
          message: getErrorMessage(error),
        });
      }
    },
    [addRepo, pushNotice],
  );

  const handleRemoveProject = useCallback(
    async (repoPath: string) => {
      const repoName = pathBasename(repoPath) || "this project";
      const confirmed = await ask(
        `Remove "${repoName}" from Shep? The files on disk will not be deleted.`,
        { title: "Remove project", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
      );
      if (!confirmed) return;
      try {
        await killProjectPtys(repoPath);
        await removeRepo(repoPath);
        useTerminalStore.getState().removeProject(repoPath);
        useCommandStore.getState().removeProject(repoPath);
        useGitStore.getState().removeProject(repoPath);
        useTodoStore.getState().removeProject(repoPath);
        useSkillStore.getState().removeProject(repoPath);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t remove project",
          message: getErrorMessage(error),
        });
      }
    },
    [killProjectPtys, pushNotice, removeRepo],
  );

  const handleRenameGroup = useCallback(
    async (groupId: string, newName: string) => {
      try {
        await renameGroup(groupId, newName);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t rename group",
          message: getErrorMessage(error),
        });
      }
    },
    [renameGroup, pushNotice],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      const groupName = group?.name ?? "this group";
      const confirmed = await ask(
        `Remove group "${groupName}"? Projects in this group will become ungrouped.`,
        { title: "Remove group", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
      );
      if (!confirmed) return;
      try {
        await deleteGroup(groupId);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t delete group",
          message: getErrorMessage(error),
        });
      }
    },
    [groups, deleteGroup, pushNotice],
  );

  const handleMoveToGroup = useCallback(
    async (repoPath: string, groupId: string | null) => {
      try {
        await moveRepoToGroup(repoPath, groupId);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t move project",
          message: getErrorMessage(error),
        });
      }
    },
    [moveRepoToGroup, pushNotice],
  );

  const handleStartCommand = useCallback(
    (name: string) => {
      const path = useCommandStore.getState().activeProjectPath;
      if (!path) return;
      const cmds = useCommandStore.getState().projectCommands[path] ?? [];
      const cmd = cmds.find((c) => c.name === name);
      if (cmd) {
        const { cols, rows } = getTerminalDimensions();
        startCommand(
          {
            name: cmd.name,
            command: cmd.command,
            autostart: cmd.autostart,
            env: cmd.env,
            cwd: cmd.cwd,
          },
          cols,
          rows,
        );
      }
    },
    [startCommand, getTerminalDimensions],
  );

  const handleSelectSidebarTab = useCallback((tabId: string) => {
    useUIStore.getState().deactivateAllOverlays();
    setActiveTab(tabId);
    const store = useTerminalStore.getState();
    const allTabs = activeRepoPath ? store.getAllProjectTabs(activeRepoPath) : [];
    const tab = allTabs.find((t) => t.id === tabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      store.clearTabBell(tab.ptyId);
    }
  }, [setActiveTab, activeRepoPath]);

  const handleSelectSidebarProjectTab = useCallback(async (repoPath: string, tabId: string) => {
    useUIStore.getState().deactivateAllOverlays();
    if (repoPath !== activeRepoPath) {
      await handleSelectRepo(repoPath);
    }

    const store = useTerminalStore.getState();
    store.setActiveTab(tabId);
    const tab = store.projectState[repoPath]?.tabs.find((entry) => entry.id === tabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      store.clearTabBell(tab.ptyId);
    }
  }, [activeRepoPath, handleSelectRepo]);

  const handleCloseTab = useCallback((tabId: string) => {
    const store = useTerminalStore.getState();
    const path = store.activeProjectPath;
    if (!path) return;
    const tab = store.projectState[path]?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.kind === "terminal" || tab.kind === "assistant") {
      closeTab(tabId);
    } else {
      store.removeTab(tabId);
    }
  }, [closeTab]);

  const handleNewAssistant = useCallback(() => {
    useTerminalStore.getState().addPanelTab("launcher");
  }, []);

  const handleStartSession = useCallback(
    async (assistantId: string, mode: SessionMode, model?: string) => {
      const { cols, rows } = getTerminalDimensions();
      const ptyId = await launchAssistant(assistantId, cols, rows, mode, model);
      if (ptyId) {
        // Remove the launcher panel tab — the new terminal tab is now active
        useTerminalStore.getState().removePanelTab("launcher");
        useUIStore.getState().deactivateAllOverlays();
        return true;
      }
      return false;
    },
    [launchAssistant, getTerminalDimensions],
  );

  const handleNewShell = useCallback(() => {
    useUIStore.getState().deactivateAllOverlays();
    const { cols, rows } = getTerminalDimensions();
    spawnBlankShell(cols, rows);
  }, [spawnBlankShell, getTerminalDimensions]);

  const handleCreateCommand = useCallback(
    async (command: CommandConfig) => {
      if (!activeRepoPath) return false;
      const nextCommands = [...commands.map(toCommandConfig), command];
      const saved = await persistWorkspaceCommands(nextCommands);
      if (!saved) return false;
      useCommandStore.getState().addCommandForProject(activeRepoPath, command);
      return true;
    },
    [activeRepoPath, commands, persistWorkspaceCommands],
  );

  const handleUpdateCommand = useCallback(
    async (previousName: string, command: CommandConfig) => {
      if (!activeRepoPath) return false;
      const nextCommands = commands.map((existing) =>
        existing.name === previousName ? command : toCommandConfig(existing),
      );
      const saved = await persistWorkspaceCommands(nextCommands);
      if (!saved) return false;
      await stopCommand(previousName);
      useCommandStore.getState().updateCommandForProject(
        activeRepoPath,
        previousName,
        command,
      );
      return true;
    },
    [activeRepoPath, commands, persistWorkspaceCommands, stopCommand],
  );

  const handleDeleteCommand = useCallback(
    async (name: string) => {
      if (!activeRepoPath) return;
      const nextCommands = commands
        .filter((command) => command.name !== name)
        .map(toCommandConfig);
      const saved = await persistWorkspaceCommands(nextCommands);
      if (!saved) return;
      await stopCommand(name);
      useCommandStore.getState().removeCommandForProject(activeRepoPath, name);
    },
    [activeRepoPath, commands, persistWorkspaceCommands, stopCommand],
  );

  const handleStartAllCommands = useCallback(async () => {
    for (const command of commands) {
      if (command.status !== "running") {
        handleStartCommand(command.name);
      }
    }
  }, [commands, handleStartCommand]);

  const handleStopAllCommands = useCallback(async () => {
    for (const command of commands) {
      if (command.status === "running") {
        await stopCommand(command.name);
      }
    }
  }, [commands, stopCommand]);

  const handleOpenInEditor = useCallback(async (repoPath: string) => {
    const preferredEditor = useEditorStore.getState().settings.preferredEditor;
    if (!preferredEditor) {
      useUIStore.getState().toggleSettings();
      return;
    }

    try {
      await openInEditor(repoPath);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("Failed to open editor:", error);
      }
      pushNotice({
        tone: "error",
        title: "Couldn’t open editor",
        message: getErrorMessage(error),
      });
    }
  }, [pushNotice]);

  useEffect(() => {
    if (restoreAttemptedRef.current || activeRepoPath || repos.length === 0) return;

    restoreAttemptedRef.current = true;

    const storedRepoPath = window.localStorage.getItem(LAST_REPO_STORAGE_KEY);
    const initialRepo =
      repos.find((repo) => repo.path === storedRepoPath) ??
      repos[0];

    if (initialRepo) {
      void handleSelectRepo(initialRepo.path);
    }
  }, [repos, activeRepoPath, handleSelectRepo]);

  // Listen for backend "quit-requested" event (red close button or Cmd+Q with active PTYs)
  const quitDialogOpenRef = useRef(false);
  useEffect(() => {
    const unlisten = listen<number>("quit-requested", async (event) => {
      if (quitDialogOpenRef.current) return;
      quitDialogOpenRef.current = true;
      try {
        const count = event.payload;
        const confirmed = await ask(
          `Quit Shep and stop ${count} running session${count === 1 ? "" : "s"}?`,
          { title: "Quit Shep", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
        );
        if (confirmed) {
          await shutdownAndQuit();
        }
      } finally {
        quitDialogOpenRef.current = false;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Handle native menu events (accelerators for Cmd+T, Cmd+Shift+T, Cmd+B, Cmd+E, Cmd+, etc.)
  useEffect(() => {
    const unlisten = listen<string>("menu-event", (event) => {
      switch (event.payload) {
        case "new_terminal":
          handleNewShell();
          break;
        case "new_agent":
          handleNewAssistant();
          break;
        case "new_commands":
          useTerminalStore.getState().addPanelTab("commands");
          break;
        case "new_git":
          useTerminalStore.getState().addPanelTab("git");
          break;
        case "toggle_sidebar":
          useUIStore.getState().toggleSidebar();
          break;
        case "open_in_editor": {
          const repoPath = useTerminalStore.getState().activeProjectPath;
          if (repoPath) handleOpenInEditor(repoPath);
          break;
        }
        case "settings":
          useUIStore.getState().toggleSettings();
          break;
        case "check_updates":
          void useUpdateStore.getState().checkForUpdate().then(() => {
            const { status, availableVersion } = useUpdateStore.getState();
            if (status === "available" && availableVersion) {
              pushNotice(
                { tone: "info", title: "Update available", message: `Version ${availableVersion} is ready to download` },
                { durationMs: 8000 },
              );
            } else if (status === "idle") {
              pushNotice({ tone: "success", title: "You're up to date", message: "No updates available" });
            }
          });
          break;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [handleNewShell, handleNewAssistant, handleOpenInEditor, pushNotice]);

  // Windows has no native menu (a Win32 menu strip can't sit under the custom
  // titlebar, and native accelerators would steal Ctrl chords from the
  // terminal), so app shortcuts are handled here. All chords use Ctrl+Shift —
  // plain Ctrl+letter is a terminal control character — mirroring Windows
  // Terminal conventions.
  useEffect(() => {
    if (!isWindows) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        useUIStore.getState().toggleSettings();
        return;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      const dispatch = (action: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        action();
      };
      switch (e.key.toLowerCase()) {
        case "t":
          dispatch(handleNewShell);
          break;
        case "a":
          dispatch(handleNewAssistant);
          break;
        case "m":
          dispatch(() => useTerminalStore.getState().addPanelTab("commands"));
          break;
        case "g":
          dispatch(() => useTerminalStore.getState().addPanelTab("git"));
          break;
        case "b":
          dispatch(() => useUIStore.getState().toggleSidebar());
          break;
        case "e":
          dispatch(() => {
            const repoPath = useTerminalStore.getState().activeProjectPath;
            if (repoPath) handleOpenInEditor(repoPath);
          });
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleNewShell, handleNewAssistant, handleOpenInEditor]);

  const showOverlay = settingsActive || usagePanelActive || portsPanelActive;

  return (
    <div className="app-shell">
      <NoticeCenter />
      <div
        className="drag-region"
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.buttons === 1) {
            if (e.detail === 2) {
              getCurrentWindow().toggleMaximize();
            } else {
              getCurrentWindow().startDragging();
            }
          }
        }}
      >
        <div className={`absolute ${isWindows ? "right-36" : "right-4"} top-1/2 -translate-y-1/2 flex items-center gap-0.5 z-20`}>
          <button
            onClick={(e) => { e.stopPropagation(); useUIStore.getState().toggleSidebar(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-1 rounded transition-opacity hover:opacity-70 ${sidebarVisible ? "opacity-40" : "opacity-15"}`}
            title={sidebarVisible ? `Hide sidebar (${modKeyLabel}+${isWindows ? "Shift+" : ""}B)` : `Show sidebar (${modKeyLabel}+${isWindows ? "Shift+" : ""}B)`}
            aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          >
            <PanelLeft size={20} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); useUIStore.getState().toggleDiffPanel(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-1 rounded transition-opacity hover:opacity-70 ${diffPanelVisible ? "opacity-40" : "opacity-15"}`}
            title={diffPanelVisible ? "Hide diff panel" : "Show diff panel"}
            aria-label={diffPanelVisible ? "Hide diff panel" : "Show diff panel"}
          >
            <PanelRight size={20} />
          </button>
        </div>
        {isWindows && (
          <div className="window-caption" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="window-caption__button"
              onClick={() => getCurrentWindow().minimize()}
              aria-label="Minimize"
            >
              <Minus size={16} />
            </button>
            <button
              className="window-caption__button"
              onClick={() => getCurrentWindow().toggleMaximize()}
              aria-label="Maximize"
            >
              <Square size={13} />
            </button>
            <button
              className="window-caption__button window-caption__button--close"
              onClick={() => getCurrentWindow().close()}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="app-shell__frame">
        {sidebarVisible && (
          <Sidebar
            repos={repos}
            groups={groups}
            activeRepoPath={activeRepoPath}
            activeTabId={showOverlay ? null : activeTabId}
            commands={commands}
            onSelectRepo={handleSelectRepo}
            onAddProject={handleAddProject}
            onRemoveProject={handleRemoveProject}
            onNewAssistant={handleNewAssistant}
            onOpenInEditor={handleOpenInEditor}
            onSelectTab={handleSelectSidebarTab}
            onSelectProjectTab={handleSelectSidebarProjectTab}
            onCloseTab={handleCloseTab}
            onNewShell={handleNewShell}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            onMoveToGroup={handleMoveToGroup}
          />
        )}

        <div className="workspace-panel">
          <TabBar
            onClose={handleCloseTab}
            onNewShell={handleNewShell}
            onNewAssistant={handleNewAssistant}
            onNewCommands={() => useTerminalStore.getState().addPanelTab("commands")}
            onNewGit={() => useTerminalStore.getState().addPanelTab("git")}
            onOpenInEditor={() => { const p = useTerminalStore.getState().activeProjectPath; if (p) handleOpenInEditor(p); }}
          />

          <div ref={terminalContainerRef} className="terminal-stage">
            {/* Global overlays (Settings, Usage, Ports) */}
            {settingsActive && (
              <Suspense fallback={<PanelLoader />}>
                <SettingsPanel />
              </Suspense>
            )}
            {usagePanelActive && (
              <Suspense fallback={<PanelLoader />}>
                <UsagePanel />
              </Suspense>
            )}
            {portsPanelActive && (
              <Suspense fallback={<PanelLoader />}>
                <PortsPanel />
              </Suspense>
            )}

            {/* Local panel tabs (Git, Commands, Launcher) */}
            {!showOverlay && activeTab?.kind === "git" && (
              <Suspense fallback={<PanelLoader />}>
                <GitPanel />
              </Suspense>
            )}
            {!showOverlay && activeTab?.kind === "commands" && (
              <Suspense fallback={<PanelLoader />}>
                <CommandsPanel
                  commands={commands}
                  onStartCommand={handleStartCommand}
                  onStopCommand={stopCommand}
                  onCreateCommand={handleCreateCommand}
                  onUpdateCommand={handleUpdateCommand}
                  onDeleteCommand={handleDeleteCommand}
                  onStartAllCommands={handleStartAllCommands}
                  onStopAllCommands={handleStopAllCommands}
                />
              </Suspense>
            )}
            {!showOverlay && activeTab?.kind === "launcher" && (
              <Suspense fallback={<PanelLoader />}>
                <SessionLauncher onStartSession={handleStartSession} />
              </Suspense>
            )}
            {!showOverlay && activeTab?.kind === "todos" && (
              <Suspense fallback={<PanelLoader />}>
                <TodosPanel />
              </Suspense>
            )}

            {!showOverlay && !activeTab && tabs.length === 0 && (
              <div className="terminal-empty">
                {activeRepoPath
                  ? "Launch an assistant or open a terminal"
                  : "Select or add a project to begin"}
              </div>
            )}
            {allTerminalTabs.map((tab) => (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  display:
                    !showOverlay && tab.repoPath === activeProjectPath && tab.id === activeTabId
                      ? "block"
                      : "none",
                }}
              >
                <TerminalErrorBoundary>
                  <TerminalView
                    ptyId={tab.ptyId}
                    visible={!showOverlay && tab.repoPath === activeProjectPath && tab.id === activeTabId}
                  />
                </TerminalErrorBoundary>
              </div>
            ))}
          </div>
        </div>

        {diffPanelVisible && (
          <Suspense fallback={null}>
            <DiffSummaryPanel />
          </Suspense>
        )}
      </div>
    </div>
  );
}
