import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { watchRepo, unwatchRepo } from "../lib/tauri";
import { useGitStore } from "../stores/useGitStore";
import { useTodoStore } from "../stores/useTodoStore";
import { useSkillStore } from "../stores/useSkillStore";
import { useProjectSettingsStore } from "../stores/useProjectSettingsStore";

interface FsChangedPayload {
  paths: string[];
  todoPaths: string[];
}

/**
 * Watches repo paths for git changes via file system events.
 * Each project (including worktrees added as separate projects) is watched independently.
 */
export function useGitWatcher(repoPaths: string[]) {
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = listen<FsChangedPayload>("git-fs-changed", (event) => {
      void useGitStore.getState().refreshAll(event.payload.paths);
      void useSkillStore.getState().refreshAll(event.payload.paths);
      if (
        useProjectSettingsStore.getState().settings.showTodos &&
        event.payload.todoPaths.length > 0
      ) {
        void useTodoStore.getState().refreshAll(event.payload.todoPaths);
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const { refreshAll } = useGitStore.getState();
    const current = new Set(repoPaths);
    const watched = watchedRef.current;

    // Watch newly added paths
    for (const path of current) {
      if (!watched.has(path)) {
        watched.add(path);
        void watchRepo(path).catch(() => {
          watchedRef.current.delete(path);
        });
      }
    }

    // Unwatch removed paths
    for (const path of [...watched]) {
      if (!current.has(path)) {
        watched.delete(path);
        void unwatchRepo(path).catch(() => undefined);
      }
    }

    // Initial refresh
    void refreshAll(repoPaths);
    void useSkillStore.getState().refreshAll(repoPaths);
  }, [repoPaths.join("\0")]);

  useEffect(() => {
    return () => {
      for (const path of watchedRef.current) {
        void unwatchRepo(path).catch(() => undefined);
      }
      watchedRef.current.clear();
    };
  }, []);
}
