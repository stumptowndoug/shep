// Project file lists for chat's `@` picker, cached per project and refreshed
// when a mention starts after a short while, so new files show up.
import { listProjectFiles } from "../tauri";

const FRESH_MS = 30_000;
const EMPTY: ReadonlySet<string> = new Set();

interface Entry {
  files: string[];
  set: ReadonlySet<string>;
  loadedAt: number;
  pending?: Promise<string[]>;
}

const cache = new Map<string, Entry>();

/** The project's files, from cache when fresh; otherwise loaded (once at a time). */
export function loadProjectFiles(repoPath: string): Promise<string[]> {
  const entry = cache.get(repoPath);
  if (entry?.pending) return entry.pending;
  if (entry && Date.now() - entry.loadedAt < FRESH_MS) return Promise.resolve(entry.files);
  const pending = listProjectFiles(repoPath)
    .then(files => {
      cache.set(repoPath, { files, set: new Set(files), loadedAt: Date.now() });
      return files;
    })
    .catch(error => {
      // Keep any earlier list; a failed refresh shouldn't empty the picker.
      if (entry) cache.set(repoPath, { ...entry, pending: undefined });
      else cache.delete(repoPath);
      throw error;
    });
  cache.set(repoPath, { files: entry?.files ?? [], set: entry?.set ?? EMPTY, loadedAt: entry?.loadedAt ?? 0, pending });
  return pending;
}

/** Files known for a project so far, for resolving mentions when a prompt is sent. */
export function knownProjectFiles(repoPath: string): ReadonlySet<string> {
  return cache.get(repoPath)?.set ?? EMPTY;
}
