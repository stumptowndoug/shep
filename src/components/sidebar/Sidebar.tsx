import { useCallback, useEffect, useMemo, useState } from "react";
import type { RepoInfo, RepoGroup, TabActivity } from "../../lib/types";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import ProjectList from "./ProjectList";
import SidebarFooter from "./SidebarFooter";
import SidebarUsage from "./SidebarUsage";
import AgentSessionList, { type AgentSessionItem } from "./AgentSessionList";
import SidebarSectionToggle from "./SidebarSectionToggle";
import type { ProjectActionKind } from "../shared/ProjectActionMenu";

function agentSessionPriority(activity: TabActivity | undefined): number {
  if (activity?.bell || activity?.agentState === "blocked") return 0;
  if (activity && !activity.alive && activity.exitCode !== 0) return 0;
  if (activity?.agentState === "possibly_stuck") return 1;
  if (activity?.agentDone) return 2;
  if (activity?.active || activity?.agentState === "working") return 3;
  return 4;
}

interface SidebarProps {
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  onSelectRepo: (repoPath: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onRemoveProject: (repoPath: string) => void;
  onOpenInEditor: (repoPath: string) => void;
  onProjectAction: (repoPath: string, action: ProjectActionKind) => void;
  onSelectProjectTab: (repoPath: string, tabId: string) => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
}

export default function Sidebar({
  repos,
  groups,
  activeRepoPath,
  activeTabId,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onOpenInEditor,
  onProjectAction,
  onSelectProjectTab,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
}: SidebarProps) {
  // Projects always starts expanded on launch; collapsing is per-session only.
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const projectState = useTerminalStore((s) => s.projectState);
  const tabActivity = useTerminalStore((s) => s.tabActivity);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const projectSettings = useProjectSettingsStore((s) => s.settings);
  const projectSettingsLoaded = useProjectSettingsStore((s) => s.hasLoaded);
  const loadProjectSettings = useProjectSettingsStore((s) => s.loadSettings);

  const agentSessions = useMemo<AgentSessionItem[]>(() => {
    const repoNames = new Map(repos.map((repo) => [repo.path, repo.name]));

    const sessions: AgentSessionItem[] = [];
    for (const [repoPath, state] of Object.entries(projectState)) {
      const projectName = repoNames.get(repoPath) ?? repoPath.split("/").filter(Boolean).pop() ?? repoPath;
      const branchName = gitStatuses[repoPath]?.branch?.trim() || null;
      for (const tab of state.tabs) {
        if (tab.kind !== "assistant") continue;
        const activity = tabActivity[tab.ptyId];
        if (activity && !activity.alive && activity.exitCode === 0) continue;
        sessions.push({ tab, projectName, branchName });
      }
    }

    return sessions.sort((a, b) => {
      const aActivity = tabActivity[a.tab.ptyId];
      const bActivity = tabActivity[b.tab.ptyId];
      const priorityDifference = agentSessionPriority(aActivity) - agentSessionPriority(bActivity);
      if (priorityDifference !== 0) return priorityDifference;

      const aIsSelected = a.tab.repoPath === activeRepoPath && a.tab.id === activeTabId;
      const bIsSelected = b.tab.repoPath === activeRepoPath && b.tab.id === activeTabId;
      if (aIsSelected !== bIsSelected) return aIsSelected ? -1 : 1;

      const recentDifference = (bActivity?.lastOutputAt ?? 0) - (aActivity?.lastOutputAt ?? 0);
      return recentDifference || a.projectName.localeCompare(b.projectName) || a.tab.label.localeCompare(b.tab.label);
    });
  }, [repos, projectState, tabActivity, gitStatuses, activeRepoPath, activeTabId]);

  const handleToggleProjects = useCallback(() => {
    setProjectsCollapsed((value) => !value);
  }, []);

  useEffect(() => {
    if (!projectSettingsLoaded) void loadProjectSettings();
  }, [projectSettingsLoaded, loadProjectSettings]);

  return (
    <div className="w-72 shrink-0 flex flex-col h-full pr-4 mr-4 border-r border-[var(--glass-border)]" onContextMenu={(e) => e.preventDefault()}>
      <div className="flex-1 overflow-y-auto min-h-0">
        <AgentSessionList
          sessions={agentSessions}
          activeRepoPath={activeRepoPath}
          activeTabId={activeTabId}
          labelMode={projectSettings.agentLabelMode}
          onSelectSession={onSelectProjectTab}
        />
        <div className="sidebar-section px-2 pb-2">
          <SidebarSectionToggle
            label="Projects"
            collapsed={projectsCollapsed}
            badge={repos.length}
            onToggle={handleToggleProjects}
          />
          {!projectsCollapsed && (
            <ProjectList
              repos={repos}
              groups={groups}
              activeRepoPath={activeRepoPath}
              onSelectRepo={onSelectRepo}
              onAddProject={onAddProject}
              onRemoveProject={onRemoveProject}
              onOpenInEditor={onOpenInEditor}
              onProjectAction={onProjectAction}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
              onMoveToGroup={onMoveToGroup}
            />
          )}
        </div>
      </div>
      <SidebarUsage />
      <SidebarFooter />
    </div>
  );
}
