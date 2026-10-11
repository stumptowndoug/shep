import { useCallback, useMemo, useState } from "react";
import { Folder, FolderPlus, GitFork, LayoutGrid, Pin, Search } from "lucide-react";
import type { RepoInfo } from "../../lib/types";
import { useGitStore } from "../../stores/useGitStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUIStore } from "../../stores/useUIStore";
import { abbreviateHome, compareByRecency, projectLiveState, type ProjectLiveState } from "../../lib/projectTree";

type Item =
  | { kind: "project"; repo: RepoInfo; parentName: string | null; live: ProjectLiveState | null; groupName: string | null }
  | { kind: "add" | "all"; label: string };

interface ProjectSwitcherProps {
  activeRepoPath: string | null;
  onSelectRepo: (repoPath: string) => void;
  onAddProject: () => void;
}

/** Higher is better; null means no match. */
function matchScore(query: string, repo: RepoInfo, parentName: string | null, groupName: string | null): number | null {
  const name = repo.name.toLowerCase();
  const label = parentName ? `${parentName.toLowerCase()} ${name}` : name;
  if (name.startsWith(query)) return 4;
  if (label.includes(query)) return 3;
  // Typing a group's name brings up everything in it.
  if (groupName?.toLowerCase().includes(query)) return 2.5;
  let index = 0;
  for (const char of label) {
    if (char === query[index]) index += 1;
    if (index === query.length) return 2;
  }
  return repo.path.toLowerCase().includes(query) ? 1 : null;
}

function close() {
  useUIStore.getState().setProjectSwitcherOpen(false);
}

/**
 * ⌘P: jump to any project. With no query, live projects come first, then
 * pinned, then by recency — and the current project sits last so Enter
 * flips back to the previous one.
 */
export default function ProjectSwitcher({ activeRepoPath, onSelectRepo, onAddProject }: ProjectSwitcherProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [previousFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusScope = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    element.querySelector("input")?.focus();
    return () => {
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
    };
  }, [previousFocus]);
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const projectState = useTerminalStore((s) => s.projectState);
  const tabActivity = useTerminalStore((s) => s.tabActivity);

  const items = useMemo<Item[]>(() => {
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));
    const projects = repos.map((repo) => ({
      kind: "project" as const,
      repo,
      parentName: gitStatuses[repo.path]?.worktree_parent ?? null,
      live: projectLiveState(projectState[repo.path], tabActivity),
      groupName: repo.group ? groupNames.get(repo.group) ?? null : null,
    }));

    const tier = (item: (typeof projects)[number]) =>
      item.repo.path === activeRepoPath ? 3 : item.live ? 0 : item.repo.pinned ? 1 : 2;
    const q = query.trim().toLowerCase();
    let ordered: typeof projects;
    if (q) {
      const scored = projects
        .map((item) => ({ item, score: matchScore(q, item.repo, item.parentName, item.groupName) }))
        .filter((entry): entry is { item: (typeof projects)[number]; score: number } => entry.score !== null);
      scored.sort((a, b) => b.score - a.score || tier(a.item) - tier(b.item) || compareByRecency(a.item.repo, b.item.repo));
      ordered = scored.map((entry) => entry.item);
    } else {
      ordered = [...projects].sort((a, b) => tier(a) - tier(b) || compareByRecency(a.repo, b.repo));
    }

    return [
      ...ordered,
      { kind: "add", label: "Add project…" },
      { kind: "all", label: "All projects" },
    ];
  }, [repos, groups, gitStatuses, projectState, tabActivity, activeRepoPath, query]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    if (item.kind === "project") onSelectRepo(item.repo.path);
    else if (item.kind === "add") onAddProject();
    else if (!useUIStore.getState().projectsPanelActive) useUIStore.getState().toggleProjectsPanel();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setSelected((index) => (index + 1) % items.length);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setSelected((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[selected]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // The search field is the switcher's only tab stop; arrows choose items.
      event.preventDefault();
      event.currentTarget.querySelector("input")?.focus();
    }
  };

  return (
    <div className="switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={focusScope} className="switcher" role="dialog" aria-modal="true" aria-label="Switch project" onKeyDown={handleKeyDown}>
        <div className="switcher__search">
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            placeholder="Switch to project…"
            aria-label="Search projects"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="project-switcher-list"
            aria-activedescendant={`project-switcher-${selected}`}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="switcher__kbd">esc</kbd>
        </div>
        <ul className="switcher__list" id="project-switcher-list" role="listbox">
          {items.map((item, index) => {
            const isSelected = index === selected;
            const common = {
              id: `project-switcher-${index}`,
              role: "option" as const,
              "aria-selected": isSelected,
              className: `switcher__item ${isSelected ? "switcher__item--selected" : ""} ${item.kind !== "project" ? "switcher__item--action" : ""}`,
              onMouseMove: () => { if (!isSelected) setSelected(index); },
              onClick: () => choose(item),
              ref: isSelected ? (el: HTMLLIElement | null) => el?.scrollIntoView({ block: "nearest" }) : undefined,
            };
            if (item.kind !== "project") {
              return (
                <li key={item.kind} {...common}>
                  {item.kind === "add" ? <FolderPlus size={14} /> : <LayoutGrid size={14} />}
                  <span className="switcher__name">{item.label}</span>
                  {item.kind === "all" && <span className="switcher__meta">⇧⌘P</span>}
                </li>
              );
            }
            const { repo, parentName, live, groupName } = item;
            return (
              <li key={repo.path} {...common}>
                {parentName ? <GitFork size={14} /> : <Folder size={14} />}
                <span className="switcher__label">
                  <span className="switcher__name">
                    {parentName && <span className="switcher__parent">{parentName} › </span>}
                    {repo.name}
                  </span>
                  <span className="switcher__path">{abbreviateHome(repo.path)}</span>
                </span>
                {repo.path === activeRepoPath && <span className="switcher__meta">current</span>}
                {groupName && <span className="switcher__meta">{groupName}</span>}
                {repo.pinned && <Pin size={11} fill="currentColor" className="switcher__pin" aria-label="Pinned" />}
                {live && <span className="project-row__count" title={`${live.sessions} open`}>{live.sessions}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
