import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, Folders, LayoutGrid, Pin, PinOff, Search } from "lucide-react";
import ContextMenu from "../shared/ContextMenu";
import type { RepoGroup, RepoInfo } from "../../lib/types";
import { useGitStore } from "../../stores/useGitStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUIStore } from "../../stores/useUIStore";
import { buildProjectTree, projectLiveState, type ProjectLiveState } from "../../lib/projectTree";
import ProjectItem from "./ProjectItem";
import { toggleGroupPin, type ProjectHandlers } from "../shared/useProjectMenu";

interface ProjectListProps {
  repos: RepoInfo[];
  activeRepoPath: string | null;
  handlers: ProjectHandlers;
  onSelectRepo: (repoPath: string) => void;
}

interface Row {
  repo: RepoInfo;
  parentName: string | null;
  nested: boolean;
  live: ProjectLiveState | null;
}

/**
 * The sidebar's working set: pinned groups (with all their projects), then
 * loose projects that have open tabs, are pinned, or are active. Everything
 * else lives on the Projects page and in ⌘P.
 */
export default function ProjectList({ repos, activeRepoPath, handlers, onSelectRepo }: ProjectListProps) {
  const groups = useRepoStore((s) => s.groups);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const projectState = useTerminalStore((s) => s.projectState);
  const tabActivity = useTerminalStore((s) => s.tabActivity);
  const projectsPageActive = useUIStore((s) => s.projectsPanelActive);
  // Groups start collapsed; expanding is per-session only.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const { groupBlocks, looseRows } = useMemo(() => {
    const pinnedGroups = groups.filter((g) => g.pinned).sort((a, b) => a.order - b.order);
    const pinnedIds = new Set(pinnedGroups.map((g) => g.id));
    const grouped = new Map<string, Row[]>(pinnedGroups.map((g) => [g.id, []]));
    const loose: Row[] = [];
    const liveFor = (repo: RepoInfo) => projectLiveState(projectState[repo.path], tabActivity);
    const include = (repo: RepoInfo, live: ProjectLiveState | null) =>
      repo.pinned || live !== null || repo.path === activeRepoPath;

    for (const node of buildProjectTree(repos, gitStatuses)) {
      const parentName = gitStatuses[node.repo.path]?.worktree_parent ?? null;
      const groupRows = node.repo.group && pinnedIds.has(node.repo.group) ? grouped.get(node.repo.group)! : null;
      if (groupRows) {
        // A pinned group shows every project in it, worktrees included.
        groupRows.push({ repo: node.repo, parentName, nested: false, live: liveFor(node.repo) });
        for (const worktree of node.worktrees) {
          groupRows.push({ repo: worktree, parentName: node.repo.name, nested: true, live: liveFor(worktree) });
        }
        continue;
      }
      const rootLive = liveFor(node.repo);
      const rootShown = include(node.repo, rootLive);
      if (rootShown) loose.push({ repo: node.repo, parentName, nested: false, live: rootLive });
      for (const worktree of node.worktrees) {
        const live = liveFor(worktree);
        if (!include(worktree, live)) continue;
        loose.push({ repo: worktree, parentName: node.repo.name, nested: rootShown, live });
      }
    }

    return {
      groupBlocks: pinnedGroups.map((group) => ({ group, rows: grouped.get(group.id)! })),
      looseRows: loose,
    };
  }, [repos, groups, gitStatuses, projectState, tabActivity, activeRepoPath]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const renderRow = (row: Row) => {
    return (
      <ProjectItem
        key={row.repo.path}
        repo={row.repo}
        parentName={row.parentName}
        nested={row.nested}
        isActive={row.repo.path === activeRepoPath}
        live={row.live}
        handlers={handlers}
        onSelect={() => onSelectRepo(row.repo.path)}
      />
    );
  };

  return (
    <div className="side-list">
      {groupBlocks.map(({ group, rows }) => {
        const collapsed = !expandedGroups.has(group.id);
        // Keep the active project visible even when its group is collapsed.
        const visibleRows = collapsed ? rows.filter((row) => row.repo.path === activeRepoPath) : rows;
        return (
          <div key={group.id} className="project-group">
            <SidebarGroupHeader
              group={group}
              count={rows.length}
              collapsed={collapsed}
              onToggle={() => toggleGroup(group.id)}
              onAddProject={() => handlers.onPickAndAddProject(group.id)}
            />
            {visibleRows.length > 0 && <div className="project-group__rows">{visibleRows.map(renderRow)}</div>}
            {!collapsed && rows.length === 0 && <div className="side-empty project-group__empty">No projects yet</div>}
          </div>
        );
      })}
      {looseRows.map(renderRow)}
      {repos.length === 0 && <div className="side-empty">Add a folder to get started.</div>}
      {/* One compact row: find (⌘P), the full Projects page, and add. */}
      <div className="project-list__tools">
        {repos.length > 0 && (
          <button
            type="button"
            className="project-list__find"
            onClick={() => useUIStore.getState().setProjectSwitcherOpen(true)}
            aria-haspopup="dialog"
          >
            <Search size={14} aria-hidden="true" />
            <span className="truncate">Find project</span>
            <kbd>⌘P</kbd>
          </button>
        )}
        {repos.length > 0 && (
          <button
            type="button"
            className={`project-list__tool ${projectsPageActive ? "project-list__tool--on" : ""}`}
            onClick={() => useUIStore.getState().toggleProjectsPanel()}
            aria-pressed={projectsPageActive}
            title="All projects (⇧⌘P)"
            aria-label="All projects"
          >
            <LayoutGrid size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={repos.length > 0 ? "project-list__tool" : "project-list__find"}
          onClick={() => handlers.onPickAndAddProject()}
          title="Add project"
          aria-label="Add project"
        >
          <FolderPlus size={14} aria-hidden="true" />
          {repos.length === 0 && <span className="truncate">Add project</span>}
        </button>
      </div>
    </div>
  );
}

function SidebarGroupHeader({
  group,
  count,
  collapsed,
  onToggle,
  onAddProject,
}: {
  group: RepoGroup;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAddProject: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className="project-group__header"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu && createPortal(
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Add Project Here…", icon: <FolderPlus size={14} />, onClick: onAddProject },
            { label: "Unpin from Sidebar", icon: <PinOff size={14} />, onClick: () => toggleGroupPin(group) },
          ]}
        />,
        document.body,
      )}
      <button type="button" className="project-group__toggle" onClick={onToggle} aria-expanded={!collapsed}>
        <Folders size={14} className="project-group__icon" />
        <span className="truncate">{group.name}</span>
        <span className="project-group__count">{count}</span>
      </button>
      <button
        type="button"
        className="project-row__pin project-row__pin--on"
        onClick={() => toggleGroupPin(group)}
        title="Unpin group from sidebar"
        aria-label={`Unpin ${group.name} from sidebar`}
      >
        <Pin size={12} fill="currentColor" />
      </button>
    </div>
  );
}
