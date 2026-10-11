import { useMemo } from "react";
import { GitBranch } from "lucide-react";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useGitChanges } from "../../hooks/useGitChanges";
import { summarizeChanges } from "../../lib/gitChangeSummary";

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Repo, branch, and diff totals as one button; opens the Changes panel. */
export default function GitSummary({ active }: { active: boolean }) {
  const repoPath = useTerminalStore((s) => s.activeProjectPath);
  const status = useGitStore((s) => (repoPath ? s.projectGitStatus[repoPath] : undefined));
  const isGitRepo = !!status?.is_git_repo;
  const snapshot = useGitChanges(isGitRepo ? repoPath : null);
  const current = snapshot?.data;
  const summary = useMemo(() => current ? summarizeChanges(current.files, current.stats) : null, [current]);

  if (!repoPath) return null;
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
  if (!status?.is_git_repo) return <span className="git-summary git-summary--plain">{repoName}</span>;

  const branch = status.branch && status.branch !== "(detached)" ? status.branch : "detached";
  const files = summary?.files ?? [];
  const additions = summary?.additions ?? 0;
  const deletions = summary?.deletions ?? 0;
  const fileLabel = !summary ? (snapshot?.error ? "Changes unavailable" : "Loading changes") : files.length > 0
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
      {current?.statsComplete === false && <span className="git-summary__sep" title="Some large files are excluded from line totals">Partial totals</span>}
    </button>
  );
}
