import { GitBranch } from "lucide-react";
import { useGitStore } from "../../stores/useGitStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { panelTabId } from "../../lib/types";

interface GitStatusRowProps {
  repoPath: string;
}

export default function GitStatusRow({ repoPath }: GitStatusRowProps) {
  const status = useGitStore((s) => s.projectGitStatus[repoPath]);
  const isActive = useTerminalStore((s) => {
    const path = s.activeProjectPath;
    if (!path) return false;
    return s.projectState[path]?.activeTabId === panelTabId("git");
  });

  if (!status?.is_git_repo) return null;

  const changeCount = status.staged + status.unstaged + status.untracked;
  const label = status.branch && status.branch !== "(detached)" ? status.branch : "Files";

  return (
    <button
      onClick={() => useTerminalStore.getState().addPanelTab("git")}
      className={`section-toggle ${isActive ? "on" : ""}`}
    >
      <GitBranch size={14} />
      <span className="truncate" title={label}>{label}</span>
      {changeCount > 0 && (
        <span className="badge">{changeCount}</span>
      )}
      {(status.ahead > 0 || status.behind > 0) && (
        <span className="badge">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.ahead > 0 && status.behind > 0 && " "}
          {status.behind > 0 && `↓${status.behind}`}
        </span>
      )}
      {status.dirty && <span className="sidebar-status-dot sidebar-status-dot--attention" />}
    </button>
  );
}
