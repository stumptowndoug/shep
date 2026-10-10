import type { ChangedFile, DiffFileStat } from "./types";

export function summarizeChanges(files: ChangedFile[], stats: DiffFileStat[]) {
  const byPath = new Map<string, ChangedFile>();
  for (const file of files) {
    const current = byPath.get(file.path);
    // Prefer the working copy when a file has both staged and unstaged changes.
    if (!current || current.area === "staged") byPath.set(file.path, file);
  }

  // Git reports the combined diff against HEAD, not one stat per staging area.
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  let additions = 0;
  let deletions = 0;
  for (const stat of statsByPath.values()) {
    additions += stat.additions;
    deletions += stat.deletions;
  }
  const size = (path: string) => {
    const stat = statsByPath.get(path);
    return (stat?.additions ?? 0) + (stat?.deletions ?? 0);
  };

  return {
    additions,
    deletions,
    files: [...byPath.values()].sort((a, b) => size(b.path) - size(a.path)),
  };
}
