import { useEffect } from "react";
import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { gitChanges } from "../lib/tauri";
import type { GitChanges } from "../lib/types";
import { getErrorMessage } from "../lib/errors";

interface Snapshot { data: GitChanges | null; error: string | null }
const useSnapshots = create<{ byRepo: Record<string, Snapshot> }>(() => ({ byRepo: {} }));
interface Watch {
  refs: number;
  running: Promise<void> | null;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  unlisten: Promise<UnlistenFn>;
}
const watches = new Map<string, Watch>();

async function refresh(repo: string, watch: Watch) {
  if (watch.running) return watch.running;
  const run = async () => {
    do {
      watch.dirty = false;
      try {
        const data = await gitChanges(repo);
        if (watches.get(repo) === watch) useSnapshots.setState(state => ({ byRepo: { ...state.byRepo, [repo]: { data, error: null } } }));
      } catch (error) {
        if (watches.get(repo) === watch) useSnapshots.setState(state => ({ byRepo: { ...state.byRepo, [repo]: { data: state.byRepo[repo]?.data ?? null, error: getErrorMessage(error) } } }));
      }
    } while (watch.dirty && watches.get(repo) === watch);
  };
  watch.running = run().finally(() => { watch.running = null; });
  return watch.running;
}

export function invalidateGitChanges(repo: string) {
  const watch = watches.get(repo);
  if (!watch) return;
  if (watch.running) { watch.dirty = true; return; }
  clearTimeout(watch.timer);
  watch.timer = setTimeout(() => void refresh(repo, watch), 300);
}

function subscribe(repo: string) {
  let watch = watches.get(repo);
  if (watch) {
    watch.refs++;
  } else {
    watch = {
      refs: 1, running: null, dirty: false,
      unlisten: listen<{ paths: string[] }>("git-fs-changed", event => {
        if (event.payload.paths.includes(repo)) invalidateGitChanges(repo);
      }),
    };
    watches.set(repo, watch);
    void refresh(repo, watch);
  }
  const subscribed = watch;
  return () => {
    if (--subscribed.refs !== 0) return;
    watches.delete(repo);
    clearTimeout(subscribed.timer);
    void subscribed.unlisten.then(stop => stop()).catch(() => {});
    useSnapshots.setState(state => {
      const { [repo]: _, ...byRepo } = state.byRepo;
      return { byRepo };
    });
  };
}

/** Sidebar and panel share one subscription and at most one in-flight snapshot per repo. */
export function useGitChanges(repo: string | null) {
  const snapshot = useSnapshots(state => repo ? state.byRepo[repo] : undefined);
  useEffect(() => repo ? subscribe(repo) : undefined, [repo]);
  return snapshot;
}
