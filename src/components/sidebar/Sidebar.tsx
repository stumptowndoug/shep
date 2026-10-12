import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInterface, RepoInfo, TabActivity } from "../../lib/types";
import { getTabActivityStatus } from "./ActivityIndicator";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import ProjectList from "./ProjectList";
import SidebarNav, { SidebarNewAgent } from "./SidebarNav";
import { startWindowDrag } from "../../lib/windowDrag";
import SidebarUsage from "./SidebarUsage";
import AgentSessionList, { type AgentSessionItem } from "./AgentSessionList";
import SidebarSectionToggle from "./SidebarSectionToggle";
import type { ProjectHandlers } from "../shared/useProjectMenu";
import type { ProjectOpenActions } from "../shared/ProjectOpenMenu";

function agentSessionPriority(activity: TabActivity | undefined, agentInterface?: AgentInterface): number {
  if (agentInterface === "chat") {
    const status = getTabActivityStatus(activity, agentInterface);
    return status === "attention" ? 0 : status === "working" ? 3 : 4;
  }
  if (activity?.bell || activity?.agentState === "blocked") return 0;
  if (activity && !activity.alive && activity.exitCode !== 0) return 0;
  if (activity?.agentState === "possibly_stuck") return 1;
  if (activity?.agentDone) return 2;
  if (activity?.active || activity?.agentState === "working") return 3;
  return 4;
}

interface SidebarProps {
  repos: RepoInfo[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  handlers: ProjectHandlers;
  openActions: ProjectOpenActions;
  onSelectRepo: (repoPath: string) => void;
  onSelectProjectTab: (repoPath: string, tabId: string) => void;
}

export default function Sidebar({
  repos,
  activeRepoPath,
  activeTabId,
  handlers,
  openActions,
  onSelectRepo,
  onSelectProjectTab,
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
      const priorityDifference = agentSessionPriority(aActivity, a.tab.agentInterface) - agentSessionPriority(bActivity, b.tab.agentInterface);
      if (priorityDifference !== 0) return priorityDifference;

      // Selection and streaming output must not move rows under the pointer.
      return a.projectName.localeCompare(b.projectName) || a.tab.label.localeCompare(b.tab.label);
    });
  }, [repos, projectState, tabActivity, gitStatuses]);

  const handleToggleProjects = useCallback(() => {
    setProjectsCollapsed((value) => !value);
  }, []);

  useEffect(() => {
    if (!projectSettingsLoaded) void loadProjectSettings();
  }, [projectSettingsLoaded, loadProjectSettings]);

  return (
    <aside className="sidebar" onContextMenu={(e) => e.preventDefault()}>
      <div className="sidebar-titlebar" onMouseDown={startWindowDrag} />
      <SidebarNewAgent hasProject={activeRepoPath !== null} openActions={openActions} />
      <div className="side-scroll">
        <AgentSessionList
          sessions={agentSessions}
          activeRepoPath={activeRepoPath}
          activeTabId={activeTabId}
          labelMode={projectSettings.agentLabelMode}
          onSelectSession={onSelectProjectTab}
        />
        <div className="side-sec side-island">
          <SidebarSectionToggle
            label="Projects"
            collapsed={projectsCollapsed}
            badge={repos.length || null}
            onToggle={handleToggleProjects}
          />
          {!projectsCollapsed && (
            <ProjectList
              repos={repos}
              activeRepoPath={activeRepoPath}
              handlers={handlers}
              onSelectRepo={onSelectRepo}
            />
          )}
        </div>
      </div>
      <div className="sidebar-bottom">
        <div className="side-island">
          <SidebarUsage />
        </div>
        <div className="side-island sidebar-toolbar">
          <SidebarNav />
        </div>
      </div>
    </aside>
  );
}
