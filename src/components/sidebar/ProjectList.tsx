import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { RepoInfo, RepoGroup, CommandState, TerminalTabData } from "../../lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import tabKindMeta from "../../lib/tabKindMeta";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import ProjectItem from "./ProjectItem";
import GroupHeader from "./GroupHeader";
import CollapsibleSection from "./CollapsibleSection";
import AssistantList from "./AssistantList";
import TerminalList from "./TerminalList";
import CommandsRow from "./CommandsRow";
import GitStatusRow from "./GitStatusRow";
import TodoRow from "./TodoRow";

interface ProjectListProps {
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  commands: CommandState[];
  projectActivity: Record<string, { terminalCount: number; runningCount: number; hasAttention: boolean; hasCrash: boolean; hasActive: boolean }>;
  onSelectRepo: (repoPath: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onRemoveProject: (repoPath: string) => void;
  onNewAssistant: () => void;
  onOpenInEditor: (repoPath: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewShell: () => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
}

export default function ProjectList({
  repos,
  groups,
  activeRepoPath,
  activeTabId,
  commands,
  projectActivity,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onNewAssistant,
  onOpenInEditor,
  onSelectTab,
  onCloseTab,
  onNewShell,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
}: ProjectListProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(activeRepoPath ? [activeRepoPath] : []),
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const createGroupSubmittedRef = useRef(false);
  const pendingMoveRepoPath = useRef<string | null>(null);

  // Auto-expand the active project when activeRepoPath changes externally
  // (e.g. session restore, programmatic selection). Legitimate useEffect:
  // syncing local UI state in response to an external prop change.
  useEffect(() => {
    if (!activeRepoPath) return;
    setExpandedPaths((prev) => {
      if (prev.has(activeRepoPath)) return prev;
      return new Set(prev).add(activeRepoPath);
    });
    // Also expand the parent group if the active repo belongs to one
    const activeRepo = repos.find((r) => r.path === activeRepoPath);
    if (activeRepo?.group) {
      setExpandedGroups((prev) => {
        if (prev.has(activeRepo.group!)) return prev;
        return new Set(prev).add(activeRepo.group!);
      });
    }
  }, [activeRepoPath, repos]);

  const handleProjectClick = (repoPath: string) => {
    if (repoPath === activeRepoPath) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(repoPath)) next.delete(repoPath);
        else next.add(repoPath);
        return next;
      });
    } else {
      setExpandedPaths((prev) => {
        if (prev.has(repoPath)) return prev;
        return new Set(prev).add(repoPath);
      });
      // Auto-expand the group containing the clicked repo
      const repo = repos.find((r) => r.path === repoPath);
      if (repo?.group) {
        setExpandedGroups((prev) => {
          if (prev.has(repo.group!)) return prev;
          return new Set(prev).add(repo.group!);
        });
      }
      onSelectRepo(repoPath);
    }
  };

  const handleToggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleAddClick = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select project folder",
    });
    if (selected) {
      onAddProject(selected);
    }
  };

  const handleCreateGroupSubmit = useCallback(() => {
    if (createGroupSubmittedRef.current) return;
    createGroupSubmittedRef.current = true;
    const trimmed = newGroupName.trim();
    const repoToMove = pendingMoveRepoPath.current;
    pendingMoveRepoPath.current = null;
    if (trimmed && repoToMove) {
      useRepoStore.getState().createGroup(trimmed)
        .then((group) => onMoveToGroup(repoToMove, group.id))
        .catch((error) => {
          useNoticeStore.getState().pushNotice({
            tone: "error",
            title: "Couldn't create group",
            message: getErrorMessage(error),
          });
        });
    }
    setCreatingGroup(false);
    setNewGroupName("");
  }, [newGroupName, onMoveToGroup]);

  // Get tabs for the active project (stable ref from store)
  const projectTabs = useTerminalStore(
    (s) => activeRepoPath ? s.projectState[activeRepoPath]?.tabs ?? null : null,
  );

  const assistantTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((t): t is TerminalTabData => t.kind === "assistant");
  }, [projectTabs]);

  const shellTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((t): t is TerminalTabData => t.kind === "terminal");
  }, [projectTabs]);

  const commandsBadge = commands.length > 0 ? String(commands.length) : null;
  const gitStatuses = useGitStore((s) => s.projectGitStatus);

  // Build grouped layout
  const { sortedGroups, groupedRepos, ungroupedRepos } = useMemo(() => {
    const validGroupIds = new Set(groups.map((g) => g.id));
    const grouped = new Map<string, RepoInfo[]>();
    const ungrouped: RepoInfo[] = [];

    for (const repo of repos) {
      if (repo.group && validGroupIds.has(repo.group)) {
        const list = grouped.get(repo.group) ?? [];
        list.push(repo);
        grouped.set(repo.group, list);
      } else {
        ungrouped.push(repo);
      }
    }

    // Sort repos within each group (worktree-aware)
    const sortFn = (a: RepoInfo, b: RepoInfo) => {
      const aWt = gitStatuses[a.path]?.worktree_parent ?? null;
      const bWt = gitStatuses[b.path]?.worktree_parent ?? null;
      const aGroup = aWt ?? a.name;
      const bGroup = bWt ?? b.name;
      const groupCompare = aGroup.localeCompare(bGroup);
      if (groupCompare !== 0) return groupCompare;
      if (aWt == null && bWt != null) return -1;
      if (aWt != null && bWt == null) return 1;
      return a.name.localeCompare(b.name);
    };

    for (const list of grouped.values()) {
      list.sort(sortFn);
    }
    ungrouped.sort(sortFn);

    const allSorted = [...groups].sort((a, b) => a.order - b.order);

    return { sortedGroups: allSorted, groupedRepos: grouped, ungroupedRepos: ungrouped };
  }, [repos, groups, gitStatuses]);

  const groupActivity = useMemo(() => {
    const result: Record<string, { hasAttention: boolean; hasCrash: boolean; hasActivity: boolean; hasActive: boolean }> = {};
    for (const group of sortedGroups) {
      const groupRepos = groupedRepos.get(group.id) ?? [];
      let hasAttention = false;
      let hasCrash = false;
      let hasActivity = false;
      let hasActive = false;
      for (const repo of groupRepos) {
        const a = projectActivity[repo.path];
        if (a) {
          if (a.terminalCount > 0 || a.runningCount > 0) hasActivity = true;
          if (a.hasAttention) hasAttention = true;
          if (a.hasCrash) hasCrash = true;
          if (a.hasActive) hasActive = true;
        }
      }
      result[group.id] = { hasAttention, hasCrash, hasActivity, hasActive };
    }
    return result;
  }, [sortedGroups, groupedRepos, projectActivity]);

  const renderRepoItem = (repo: RepoInfo) => {
    const isActive = repo.path === activeRepoPath;
    const isExpanded = isActive && expandedPaths.has(repo.path);
    const worktreeParent = gitStatuses[repo.path]?.worktree_parent ?? null;
    return (
      <div key={repo.path}>
        <ProjectItem
          repo={repo}
          isActive={isActive}
          isExpanded={isExpanded}
          activity={projectActivity[repo.path]}
          worktreeParent={worktreeParent}
          groups={groups}
          onOpenInEditor={() => onOpenInEditor(repo.path)}
          onRemove={() => onRemoveProject(repo.path)}
          onClick={() => handleProjectClick(repo.path)}
          onAddProject={onAddProject}
          onMoveToGroup={onMoveToGroup}
          onNewGroupForRepo={(repoPath) => {
            pendingMoveRepoPath.current = repoPath;
            createGroupSubmittedRef.current = false;
            setCreatingGroup(true);
          }}
        />
        {isExpanded && (
          <div className="mt-1 mb-2 flex flex-col gap-0.5 pl-2">
            <CollapsibleSection
              label={tabKindMeta.assistant.label + "s"}
              icon={tabKindMeta.assistant.icon(14)}
              badge={assistantTabs.length || null}
              hasItems={assistantTabs.length > 0}
              onAdd={onNewAssistant}
            >
              <AssistantList
                assistantTabs={assistantTabs}
                activeTabId={activeTabId}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                repositoryName={repo.name}
              />
            </CollapsibleSection>

            <CollapsibleSection
              label={tabKindMeta.terminal.label + "s"}
              icon={tabKindMeta.terminal.icon(14)}
              badge={shellTabs.length || null}
              hasItems={shellTabs.length > 0}
              onAdd={onNewShell}
            >
              <TerminalList
                tabs={shellTabs}
                activeTabId={activeTabId}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
              />
            </CollapsibleSection>

            <CommandsRow badge={commandsBadge} />
            <TodoRow repoPath={repo.path} />
            <GitStatusRow repoPath={repo.path} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {sortedGroups.map((group) => {
        const groupRepos = groupedRepos.get(group.id) ?? [];
        const isGroupExpanded = expandedGroups.has(group.id);
        return (
          <div key={group.id}>
            <GroupHeader
              group={group}
              isExpanded={isGroupExpanded}
              activity={groupActivity[group.id]}
              onToggle={() => handleToggleGroup(group.id)}
              onRename={onRenameGroup}
              onDelete={onDeleteGroup}
            />
            {isGroupExpanded && (
              <div className="pl-4">
                {groupRepos.length === 0 ? (
                  <div className="group-empty-hint">No projects in this group</div>
                ) : (
                  groupRepos.map(renderRepoItem)
                )}
              </div>
            )}
          </div>
        );
      })}

      {ungroupedRepos.map(renderRepoItem)}

      <button className="btn-ghost w-full mt-1" onClick={handleAddClick}>
        <span>+</span>
        <span>Add Project</span>
      </button>
      {creatingGroup && (
        <form
          className="group-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateGroupSubmit();
          }}
        >
          <input
            className="group-create-form__input"
            type="text"
            placeholder="Group name"
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onBlur={handleCreateGroupSubmit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                createGroupSubmittedRef.current = true;
                setCreatingGroup(false);
                setNewGroupName("");
              }
            }}
          />
        </form>
      )}
    </div>
  );
}
