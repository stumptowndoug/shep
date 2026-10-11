import { create } from "zustand";
import type { RepoInfo, RepoGroup, WorkspaceConfig } from "../lib/types";
import {
  gitListWorktrees,
  listRepos,
  registerRepo,
  unregisterRepo,
  loadWorkspace,
  listGroups,
  createGroup as ipcCreateGroup,
  renameGroup as ipcRenameGroup,
  deleteGroup as ipcDeleteGroup,
  moveRepoToGroup as ipcMoveRepoToGroup,
  setRepoPinned,
  setGroupPinned as ipcSetGroupPinned,
  markRepoOpened,
} from "../lib/tauri";
import { useProjectSettingsStore } from "./useProjectSettingsStore";
import { useNoticeStore } from "./useNoticeStore";
import { getErrorMessage } from "../lib/errors";

const EMPTY_REPOS: RepoInfo[] = [];
const EMPTY_GROUPS: RepoGroup[] = [];
let repoLoadRequest = 0;

type RelatedImportMode = "expand-main" | "main-only";

interface QueueEntry {
  path: string;
  mode: RelatedImportMode;
  isPrimary: boolean;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isMissingDirectoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Directory does not exist:");
}

interface RepoStore {
  loadStatus: "idle" | "loading" | "ready" | "error";
  loadError: string | null;
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeConfig: WorkspaceConfig | null;
  fetchRepos: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  openRepo: (repoPath: string) => Promise<WorkspaceConfig>;
  addRepo: (repoPath: string) => Promise<WorkspaceConfig>;
  removeRepo: (repoPath: string) => Promise<void>;
  setActiveConfig: (config: WorkspaceConfig | null) => void;
  clearRepo: () => void;
  createGroup: (name: string) => Promise<RepoGroup>;
  renameGroup: (groupId: string, newName: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  moveRepoToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  setPinned: (repoPath: string, pinned: boolean) => Promise<void>;
  setGroupPinned: (groupId: string, pinned: boolean) => Promise<void>;
  markOpened: (repoPath: string) => Promise<void>;
}

function patchRepo(repos: RepoInfo[], repoPath: string, patch: Partial<RepoInfo>): RepoInfo[] {
  return repos.map((repo) => (repo.path === repoPath ? { ...repo, ...patch } : repo));
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  loadStatus: "idle",
  loadError: null,
  repos: EMPTY_REPOS,
  groups: EMPTY_GROUPS,
  activeRepoPath: null,
  activeConfig: null,

  fetchRepos: async () => {
    const request = ++repoLoadRequest;
    set({ loadStatus: "loading", loadError: null });
    try {
      const repos = await listRepos();
      if (request !== repoLoadRequest) return;
      set((state) => {
        const activeStillExists = state.activeRepoPath
          ? repos.some((repo) => repo.path === state.activeRepoPath)
          : true;

        return {
          repos,
          loadStatus: "ready",
          ...(activeStillExists ? {} : { activeRepoPath: null, activeConfig: null }),
        };
      });
    } catch (error) {
      if (request !== repoLoadRequest) return;
      const message = getErrorMessage(error);
      set({ loadStatus: "error", loadError: message });
      useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn’t load projects", message });
    }
  },

  fetchGroups: async () => {
    const groups = await listGroups();
    set({ groups });
  },

  openRepo: async (repoPath: string) => {
    const config = await loadWorkspace(repoPath);
    set({ activeRepoPath: repoPath, activeConfig: config });
    return config;
  },

  addRepo: async (repoPath: string) => {
    const knownPaths = new Set(get().repos.map((repo) => repo.path));
    const queuedPaths = new Set<string>();
    const queue: QueueEntry[] = [{ path: repoPath, mode: "expand-main", isPrimary: true }];
    let primaryRegistered: Awaited<ReturnType<typeof registerRepo>> | null = null;

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;

      let registered: Awaited<ReturnType<typeof registerRepo>>;
      try {
        registered = await registerRepo(next.path);
      } catch (error) {
        // Auto-import should not block the user when Git still reports a stale,
        // already-deleted worktree path. Only the explicitly added path is fatal.
        if (!next.isPrimary && isMissingDirectoryError(error)) {
          continue;
        }
        throw error;
      }
      const canonicalPath = registered.path;
      knownPaths.add(canonicalPath);
      queuedPaths.add(canonicalPath);

      if (!primaryRegistered) {
        primaryRegistered = registered;
      }

      let worktrees;
      try {
        worktrees = await gitListWorktrees(canonicalPath);
      } catch {
        continue;
      }

      const currentEntry = worktrees.find((wt) => wt.path === canonicalPath);
      if (!currentEntry) {
        continue;
      }

      const relatedPaths =
        currentEntry.is_main
          ? next.mode === "expand-main" && useProjectSettingsStore.getState().settings.autoImportWorktrees
            ? worktrees.filter((wt) => !wt.is_main).map((wt) => wt.path)
            : []
          : worktrees.filter((wt) => wt.is_main).map((wt) => wt.path);

      for (const relatedPath of uniquePaths(relatedPaths)) {
        if (knownPaths.has(relatedPath) || queuedPaths.has(relatedPath)) {
          continue;
        }
        queue.push({
          path: relatedPath,
          mode: "main-only",
          isPrimary: false,
        });
        queuedPaths.add(relatedPath);
      }
    }

    if (!primaryRegistered) {
      throw new Error("Failed to register project");
    }

    const repos = await listRepos();
    set({
      repos,
      activeRepoPath: primaryRegistered.path,
      activeConfig: primaryRegistered.workspace,
    });
    return primaryRegistered.workspace;
  },

  removeRepo: async (repoPath: string) => {
    await unregisterRepo(repoPath);
    const repos = await listRepos();
    const isActive = get().activeRepoPath === repoPath;
    set({
      repos,
      ...(isActive ? { activeRepoPath: null, activeConfig: null } : {}),
    });
  },

  setActiveConfig: (config: WorkspaceConfig | null) => {
    set({ activeConfig: config });
  },

  clearRepo: () => {
    set({ activeRepoPath: null, activeConfig: null });
  },

  createGroup: async (name: string) => {
    const group = await ipcCreateGroup(name);
    const groups = await listGroups();
    set({ groups });
    return group;
  },

  renameGroup: async (groupId: string, newName: string) => {
    await ipcRenameGroup(groupId, newName);
    const groups = await listGroups();
    set({ groups });
  },

  deleteGroup: async (groupId: string) => {
    await ipcDeleteGroup(groupId);
    const [groups, repos] = await Promise.all([listGroups(), listRepos()]);
    set({ groups, repos });
  },

  moveRepoToGroup: async (repoPath: string, groupId: string | null) => {
    await ipcMoveRepoToGroup(repoPath, groupId);
    const repos = await listRepos();
    set({ repos });
  },

  setPinned: async (repoPath: string, pinned: boolean) => {
    const previous = get().repos;
    set({ repos: patchRepo(previous, repoPath, { pinned }) });
    try {
      await setRepoPinned(repoPath, pinned);
    } catch (error) {
      set({ repos: previous });
      throw error;
    }
  },

  setGroupPinned: async (groupId: string, pinned: boolean) => {
    const previous = get().groups;
    set({ groups: previous.map((g) => (g.id === groupId ? { ...g, pinned } : g)) });
    try {
      await ipcSetGroupPinned(groupId, pinned);
    } catch (error) {
      set({ groups: previous });
      throw error;
    }
  },

  markOpened: async (repoPath: string) => {
    const lastOpened = await markRepoOpened(repoPath);
    set((state) => ({ repos: patchRepo(state.repos, repoPath, { last_opened: lastOpened }) }));
  },
}));
