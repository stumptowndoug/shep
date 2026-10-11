import type { GitStatus, RepoInfo, TabActivity } from "./types";
import type { ProjectTerminalState } from "../stores/useTerminalStore";
import { isSessionTab } from "./types";
import { getTabActivityStatus, type ActivityIndicatorStatus } from "../components/sidebar/ActivityIndicator";

export interface ProjectNode {
  repo: RepoInfo;
  worktrees: RepoInfo[];
}

/**
 * Nest registered worktrees under their main checkout. Git only reports the
 * parent's directory name, so a worktree whose parent isn't registered (or is
 * ambiguous) stays a root of its own.
 */
export function buildProjectTree(repos: RepoInfo[], gitStatuses: Record<string, GitStatus | undefined>): ProjectNode[] {
  const roots: ProjectNode[] = [];
  const pending: RepoInfo[] = [];
  for (const repo of repos) {
    if (gitStatuses[repo.path]?.worktree_parent) pending.push(repo);
    else roots.push({ repo, worktrees: [] });
  }

  const rootsByName = new Map<string, ProjectNode[]>();
  for (const node of roots) {
    const list = rootsByName.get(node.repo.name) ?? [];
    list.push(node);
    rootsByName.set(node.repo.name, list);
  }

  for (const repo of pending) {
    const candidates = rootsByName.get(gitStatuses[repo.path]!.worktree_parent!) ?? [];
    if (candidates.length === 1) candidates[0].worktrees.push(repo);
    else roots.push({ repo, worktrees: [] });
  }

  for (const node of roots) node.worktrees.sort((a, b) => a.name.localeCompare(b.name));
  return roots.sort((a, b) => a.repo.name.localeCompare(b.repo.name));
}

export interface ProjectLiveState {
  /** Open terminal and agent tabs. */
  sessions: number;
  /** The most urgent agent status, for a single dot per project. */
  status: ActivityIndicatorStatus;
}

const STATUS_RANK: Record<ActivityIndicatorStatus, number> = {
  failed: 0, attention: 0, stuck: 1, done: 2, working: 3, active: 3, running: 4, idle: 5,
};

export function projectLiveState(
  state: ProjectTerminalState | undefined,
  tabActivity: Record<number, TabActivity | undefined>,
): ProjectLiveState | null {
  if (!state) return null;
  let sessions = 0;
  let status: ActivityIndicatorStatus = "idle";
  for (const tab of state.tabs) {
    if (!isSessionTab(tab)) continue;
    const activity = tabActivity[tab.ptyId];
    if (activity && !activity.alive && activity.exitCode === 0) continue;
    sessions += 1;
    if (tab.kind !== "assistant") continue;
    const next = getTabActivityStatus(activity, tab.agentInterface);
    if (STATUS_RANK[next] < STATUS_RANK[status]) status = next;
  }
  return sessions > 0 ? { sessions, status } : null;
}

/** Recently opened first; never-opened projects fall back to name order. */
export function compareByRecency(a: RepoInfo, b: RepoInfo): number {
  return (b.last_opened ?? 0) - (a.last_opened ?? 0) || a.name.localeCompare(b.name);
}

export function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return "Never opened";
  const minutes = Math.round((now - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function abbreviateHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}
