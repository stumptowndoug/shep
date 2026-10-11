import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { gitChangedFiles, gitDiffStats } from "../../lib/tauri";
import { summarizeChanges } from "../../lib/gitChangeSummary";
import type { ChangedFile } from "../../lib/types";

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface ChangesData {
  repoPath: string;
  files: ChangedFile[];
  summary: ReturnType<typeof summarizeChanges>;
}

/** Repo, branch, and diff totals as one button; opens the Changes panel. */
export default function GitSummary({ active }: { active: boolean }) {
  const repoPath = useTerminalStore((s) => s.activeProjectPath);
  const status = useGitStore((s) => (repoPath ? s.projectGitStatus[repoPath] : undefined));
  const isGitRepo = !!status?.is_git_repo;
  const [data, setData] = useState<ChangesData | null>(null);

  useEffect(() => {
    setData(null);
    if (!repoPath || !isGitRepo) return;

    let disposed = false;
    let request = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const currentRequest = ++request;
      try {
        const [files, stats] = await Promise.all([gitChangedFiles(repoPath), gitDiffStats(repoPath)]);
        // Neither another project nor an older refresh may replace current totals.
        if (!disposed && currentRequest === request) {
          setData({ repoPath, files, summary: summarizeChanges(files, stats) });
        }
      } catch {
        // Keep the last successful summary until the next filesystem refresh.
      }
    };
    void refresh();
    const unlisten = listen<{ paths: string[] }>("git-fs-changed", (event) => {
      if (disposed || !event.payload.paths.includes(repoPath)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), 300);
    });
    return () => {
      disposed = true;
      clearTimeout(debounce);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [repoPath, isGitRepo]);

  if (!repoPath) return null;
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
  if (!status?.is_git_repo) return <span className="git-summary git-summary--plain">{repoName}</span>;

  const branch = status.branch && status.branch !== "(detached)" ? status.branch : "detached";
  const current = data && data.repoPath === repoPath ? data : null;
  const files = current?.summary.files ?? [];
  const additions = current?.summary.additions ?? 0;
  const deletions = current?.summary.deletions ?? 0;
  const fileLabel = files.length > 0
    ? `${files.length} ${files.length === 1 ? "file" : "files"} changed`
    : "No changes";

  // The Changes panel opens on the first changed file.
  const openPanel = () => useTerminalStore.getState().addPanelTab("git");

  return (
    <button
      type="button"
      className="git-summary"
      title={`${repoName} on ${branch}\n${fileLabel}${files.length > 0 ? ` · ${additions.toLocaleString()} additions, ${deletions.toLocaleString()} deletions` : ""}`}
      aria-label={`Show changes: ${repoName} on ${branch}, ${fileLabel}${files.length > 0 ? `, ${additions} additions and ${deletions} deletions` : ""}`}
      aria-pressed={active}
      onClick={openPanel}
    >
      <GitBranch size={13} className="git-summary__icon" aria-hidden="true" />
      <span className="git-summary__repo">{repoName}</span>
      <span className="git-summary__sep" aria-hidden="true">›</span>
      <span className="git-summary__branch">{branch}</span>
      {files.length > 0 && (
        <>
          <span className="git-summary__add">+{compactNumber.format(additions)}</span>
          <span className="git-summary__del">−{compactNumber.format(deletions)}</span>
        </>
      )}
    </button>
  );
}
