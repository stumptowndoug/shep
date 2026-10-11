import { useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderPlus, Folders, GitFork, MoreHorizontal, Pencil, Pin, Search, Trash2, X } from "lucide-react";
import type { RepoGroup, RepoInfo } from "../../lib/types";
import { useGitStore } from "../../stores/useGitStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { getErrorMessage } from "../../lib/errors";
import {
  abbreviateHome,
  buildProjectTree,
  formatRelativeTime,
  projectLiveState,
  type ProjectNode,
} from "../../lib/projectTree";
import { toggleGroupPin, toggleProjectPin, useProjectMenu, type ProjectHandlers } from "../shared/useProjectMenu";

const UNGROUPED = "__ungrouped";
const DRAG_TYPE = "application/x-shep-project";

interface ProjectsPanelProps {
  activeRepoPath: string | null;
  handlers: ProjectHandlers;
  onSelectRepo: (repoPath: string) => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

function nodeMatches(node: ProjectNode, query: string): ProjectNode | null {
  if (!query) return node;
  const matches = (repo: RepoInfo) => `${repo.name} ${repo.path}`.toLowerCase().includes(query);
  if (matches(node.repo)) return node;
  const worktrees = node.worktrees.filter(matches);
  return worktrees.length > 0 ? { repo: node.repo, worktrees } : null;
}

export default function ProjectsPanel({
  activeRepoPath,
  handlers,
  onSelectRepo,
  onRenameGroup,
  onDeleteGroup,
}: ProjectsPanelProps) {
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const search = query.trim().toLowerCase();

  const sections = useMemo(() => {
    const tree = buildProjectTree(repos, gitStatuses);
    const validIds = new Set(groups.map((g) => g.id));
    const byGroup = new Map<string, ProjectNode[]>();
    for (const node of tree) {
      const matched = nodeMatches(node, search);
      if (!matched) continue;
      const key = node.repo.group && validIds.has(node.repo.group) ? node.repo.group : UNGROUPED;
      const list = byGroup.get(key) ?? [];
      list.push(matched);
      byGroup.set(key, list);
    }
    const ordered: { id: string; group: RepoGroup | null; nodes: ProjectNode[] }[] = [...groups]
      .sort((a, b) => a.order - b.order)
      .map((group) => ({ id: group.id, group, nodes: byGroup.get(group.id) ?? [] }))
      // While searching, hide groups with nothing to show.
      .filter((section) => !search || section.nodes.length > 0);
    const ungrouped = byGroup.get(UNGROUPED) ?? [];
    if (ungrouped.length > 0 || (dragging && groups.length > 0)) {
      ordered.push({ id: UNGROUPED, group: null, nodes: ungrouped });
    }
    return ordered;
  }, [repos, groups, gitStatuses, search, dragging]);

  const visibleCount = sections.reduce((sum, s) => sum + s.nodes.reduce((n, node) => n + 1 + node.worktrees.length, 0), 0);
  const pinnedCount = repos.filter((r) => r.pinned).length;

  const updateQuery = (value: string) => {
    setQuery(value);
    setCollapsed(new Set());
  };
  const clearSearch = () => {
    updateQuery("");
    searchInput.current?.focus();
  };

  const submitNewGroup = async () => {
    const name = newGroupName.trim();
    setCreatingGroup(false);
    setNewGroupName("");
    if (!name) return;
    try {
      await useRepoStore.getState().createGroup(name);
    } catch (error) {
      useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn't create group", message: getErrorMessage(error) });
    }
  };

  const toggleSection = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dropOn = (sectionId: string, event: React.DragEvent) => {
    event.preventDefault();
    const repoPath = event.dataTransfer.getData(DRAG_TYPE);
    setDragging(null);
    setDropTarget(null);
    if (!repoPath) return;
    const groupId = sectionId === UNGROUPED ? null : sectionId;
    const repo = repos.find((r) => r.path === repoPath);
    if (repo && repo.group !== groupId) void handlers.onMoveToGroup(repoPath, groupId);
  };

  const dragProps = (repo: RepoInfo) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_TYPE, repo.path);
      setDragging(repo.path);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
  });

  return (
    <div className="page projects-page">
      <div className="page__heading page__heading--actions">
        <div>
          <h1 className="page__title">Projects.</h1>
          <p className="page__lede">Everything Shep knows about. Groups and pinned projects stay in the sidebar; projects with open tabs show up there on their own.</p>
        </div>
        <div className="projects-page__actions">
          <button type="button" className="btn-secondary" onClick={() => setCreatingGroup(true)} disabled={creatingGroup}>
            <Folders size={14} aria-hidden="true" />
            New group
          </button>
          <button type="button" className="btn-primary" onClick={() => handlers.onPickAndAddProject()}>
            <FolderPlus size={14} aria-hidden="true" />
            Add project
          </button>
        </div>
      </div>

      {repos.length > 0 && (
        <div className="ports-page__toolbar">
          <div className="ports-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchInput}
              type="text"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
              placeholder="Search projects"
              aria-label="Search projects"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button type="button" className="icon-btn" aria-label="Clear search" onClick={clearSearch}>
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="ports-page__summary" role="status">
            <span>{search ? `${visibleCount} of ${repos.length} projects` : `${repos.length} ${repos.length === 1 ? "project" : "projects"}`}</span>
            {!search && pinnedCount > 0 && <span className="ports-page__project-count">{pinnedCount} pinned</span>}
          </p>
        </div>
      )}

      {creatingGroup && (
        <form
          className="projects-page__new-group"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNewGroup();
          }}
        >
          <Folders size={14} aria-hidden="true" />
          <input
            autoFocus
            type="text"
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            onBlur={() => void submitNewGroup()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setNewGroupName("");
                setCreatingGroup(false);
              }
            }}
            placeholder="Group name — Enter to create"
            aria-label="New group name"
          />
        </form>
      )}

      {repos.length === 0 && (
        <div className="ports-empty">
          <span className="ports-empty__icon" aria-hidden="true"><Folder size={22} /></span>
          <h2>No projects yet.</h2>
          <p>Add a folder to start running agents and terminals in it.</p>
          <button type="button" className="btn-primary" onClick={() => handlers.onPickAndAddProject()}>Add project</button>
        </div>
      )}

      {repos.length > 0 && search && visibleCount === 0 && (
        <div className="ports-empty">
          <span className="ports-empty__icon" aria-hidden="true"><Search size={22} /></span>
          <h2>No matching projects.</h2>
          <p>Try a project name or part of its path.</p>
          <button type="button" className="btn-ghost" onClick={clearSearch}>Clear search</button>
        </div>
      )}

      {sections.map((section) => {
        const closed = collapsed.has(section.id) && !dragging;
        const count = section.nodes.reduce((n, node) => n + 1 + node.worktrees.length, 0);
        const label = section.group?.name ?? (groups.length > 0 ? "Ungrouped" : "All projects");
        return (
          <section
            key={section.id}
            className={`project-section ${dropTarget === section.id ? "project-section--drop" : ""}`}
            aria-label={label}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (dropTarget !== section.id) setDropTarget(section.id);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
            }}
            onDrop={(event) => dropOn(section.id, event)}
          >
            <SectionHeading
              group={section.group}
              label={label}
              count={count}
              closed={closed}
              onToggle={() => toggleSection(section.id)}
              onRename={onRenameGroup}
              onDelete={onDeleteGroup}
              onAddProject={section.group ? () => handlers.onPickAndAddProject(section.group!.id) : undefined}
            />
            {!closed && (section.nodes.length === 0 ? (
              <div className="project-section__empty">
                {dragging ? "Drop to move here" : "Drag projects here, or use Move to in a project's menu."}
              </div>
            ) : (
              <ul className="project-cards">
                {section.nodes.map((node) => (
                  <ProjectNodeRows
                    key={node.repo.path}
                    node={node}
                    activeRepoPath={activeRepoPath}
                    handlers={handlers}
                    onSelectRepo={onSelectRepo}
                    dragProps={dragProps}
                    draggingPath={dragging}
                  />
                ))}
              </ul>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function SectionHeading({
  group,
  label,
  count,
  closed,
  onToggle,
  onRename,
  onDelete,
  onAddProject,
}: {
  group: RepoGroup | null;
  label: string;
  count: number;
  closed: boolean;
  onToggle: () => void;
  onRename: (groupId: string, name: string) => void;
  onDelete: (groupId: string) => void;
  onAddProject?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(label);
  const submitted = useRef(false);

  const startRename = () => {
    submitted.current = false;
    setValue(label);
    setRenaming(true);
  };
  const submit = () => {
    if (submitted.current) return;
    submitted.current = true;
    const trimmed = value.trim();
    if (group && trimmed && trimmed !== group.name) onRename(group.id, trimmed);
    setRenaming(false);
  };

  return (
    <h2 className="project-section__heading">
      {renaming ? (
        <input
          className="project-section__rename"
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") {
              submitted.current = true;
              setRenaming(false);
            }
          }}
          aria-label="Group name"
        />
      ) : (
        <button type="button" className="port-group__toggle" aria-expanded={!closed} onClick={onToggle}>
          <ChevronDown size={13} aria-hidden="true" />
          <span className="port-group__name">{label}</span>
          <span className="port-group__count">{count}</span>
        </button>
      )}
      {group && !renaming && (
        <button
          type="button"
          className={`icon-btn project-section__pin ${group.pinned ? "project-section__pin--on" : ""}`}
          onClick={() => toggleGroupPin(group)}
          title={group.pinned ? "Unpin group from sidebar" : "Pin group to sidebar"}
          aria-label={group.pinned ? `Unpin ${group.name} from sidebar` : `Pin ${group.name} to sidebar`}
          aria-pressed={group.pinned}
        >
          <Pin size={12} fill={group.pinned ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      )}
      {group && !renaming && (
        <span className="project-section__tools">
          {onAddProject && (
            <button type="button" className="icon-btn" onClick={onAddProject} title="Add project to this group" aria-label={`Add project to ${group.name}`}>
              <FolderPlus size={12} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={startRename} title="Rename group" aria-label={`Rename ${group.name}`}>
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" data-danger="true" onClick={() => onDelete(group.id)} title="Delete group" aria-label={`Delete ${group.name}`}>
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </span>
      )}
    </h2>
  );
}

function ProjectNodeRows({
  node,
  activeRepoPath,
  handlers,
  onSelectRepo,
  dragProps,
  draggingPath,
}: {
  node: ProjectNode;
  activeRepoPath: string | null;
  handlers: ProjectHandlers;
  onSelectRepo: (repoPath: string) => void;
  dragProps: (repo: RepoInfo) => React.HTMLAttributes<HTMLLIElement> & { draggable: boolean };
  draggingPath: string | null;
}) {
  const orphanParent = useGitStore((s) => s.projectGitStatus[node.repo.path]?.worktree_parent ?? null);
  return (
    <>
      <ProjectCard
        repo={node.repo}
        parentName={orphanParent}
        nested={false}
        isActive={node.repo.path === activeRepoPath}
        handlers={handlers}
        onSelect={() => onSelectRepo(node.repo.path)}
        dragProps={dragProps(node.repo)}
        isDragging={draggingPath === node.repo.path}
      />
      {node.worktrees.map((worktree) => (
        <ProjectCard
          key={worktree.path}
          repo={worktree}
          parentName={node.repo.name}
          nested
          isActive={worktree.path === activeRepoPath}
          handlers={handlers}
          onSelect={() => onSelectRepo(worktree.path)}
          dragProps={dragProps(worktree)}
          isDragging={draggingPath === worktree.path}
        />
      ))}
    </>
  );
}

function ProjectCard({
  repo,
  parentName,
  nested,
  isActive,
  handlers,
  onSelect,
  dragProps,
  isDragging,
}: {
  repo: RepoInfo;
  parentName: string | null;
  nested: boolean;
  isActive: boolean;
  handlers: ProjectHandlers;
  onSelect: () => void;
  dragProps: React.HTMLAttributes<HTMLLIElement> & { draggable: boolean };
  isDragging: boolean;
}) {
  const { handleContextMenu, openMenuAt, portals } = useProjectMenu(repo, handlers);
  const status = useGitStore((s) => s.projectGitStatus[repo.path]);
  const terminalState = useTerminalStore((s) => s.projectState[repo.path]);
  const tabActivity = useTerminalStore((s) => s.tabActivity);
  const live = useMemo(() => projectLiveState(terminalState, tabActivity), [terminalState, tabActivity]);
  const changes = status ? status.staged + status.unstaged + status.untracked : 0;
  const branch = status?.is_git_repo && status.branch && status.branch !== "(detached)" ? status.branch : null;

  // Portals stay outside the row so menu clicks don't bubble into onSelect.
  return (
    <>
      <li
        className={`project-card ${nested ? "project-card--nested" : ""} ${isActive ? "project-card--active" : ""} ${isDragging ? "project-card--dragging" : ""}`}
        {...dragProps}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Open ${parentName ? `${parentName} worktree ` : ""}${repo.name}`}
        title={repo.path}
      >
        <span className="project-card__icon" aria-hidden="true">
          {parentName ? <GitFork size={16} /> : <Folder size={16} />}
        </span>
        <div className="project-card__body">
          <div className="project-card__heading">
            <span className="project-card__name">
              {parentName && !nested && <span className="project-card__parent">{parentName} › </span>}
              {repo.name}
            </span>
            {isActive && <span className="project-card__current">Current</span>}
          </div>
          <div className="project-card__meta">
            {branch && <span className="project-card__branch">{branch}</span>}
            {changes > 0 && <span>{changes} changed</span>}
            <span className="project-card__path">{abbreviateHome(repo.path)}</span>
          </div>
        </div>
        <div className="project-card__status">
          {live ? (
            <span className="project-card__live">{live.sessions} open</span>
          ) : (
            <span>{formatRelativeTime(repo.last_opened)}</span>
          )}
        </div>
        <div className="project-card__actions">
          <button
            type="button"
            className={`icon-btn project-card__pin ${repo.pinned ? "project-card__pin--on" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleProjectPin(repo);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            title={repo.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            aria-label={repo.pinned ? `Unpin ${repo.name}` : `Pin ${repo.name}`}
            aria-pressed={repo.pinned}
          >
            <Pin size={14} fill={repo.pinned ? "currentColor" : "none"} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenuAt(rect.left, rect.bottom + 4);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            title="More actions"
            aria-label={`More actions for ${repo.name}`}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
      </li>
      {portals}
    </>
  );
}
