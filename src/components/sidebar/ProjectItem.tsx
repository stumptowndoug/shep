import { Folder, GitFork, Pin } from "lucide-react";
import type { RepoInfo } from "../../lib/types";
import type { ProjectLiveState } from "../../lib/projectTree";
import { handleActionKey, handleContextMenuKey } from "../../lib/a11y";
import { toggleProjectPin, useProjectMenu, type ProjectHandlers } from "../shared/useProjectMenu";

interface ProjectItemProps {
  repo: RepoInfo;
  /** Main checkout name when this row is a worktree. */
  parentName: string | null;
  /** Rendered beneath its parent, so the parent name is implied. */
  nested: boolean;
  isActive: boolean;
  live: ProjectLiveState | null;
  handlers: ProjectHandlers;
  onSelect: () => void;
}

export default function ProjectItem({ repo, parentName, nested, isActive, live, handlers, onSelect }: ProjectItemProps) {
  const { handleContextMenu, openMenuAt, portals } = useProjectMenu(repo, handlers);
  const showStatus = live && live.status !== "idle" && live.status !== "running";

  return (
    <>
      <div
        className={`list-item project-row ${isActive ? "project-active" : ""} ${nested ? "project-row--nested" : ""}`}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => { if (!handleContextMenuKey(event, openMenuAt)) handleActionKey(event, onSelect); }}
        title={repo.path}
        role="button"
        tabIndex={0}
        aria-current={isActive ? "true" : undefined}
        aria-label={parentName ? `${parentName} worktree ${repo.name}` : repo.name}
      >
        {parentName ? <GitFork size={14} className="project-row__icon" /> : <Folder size={14} className="project-row__icon" />}
        <span className="project-row__name">
          {parentName && !nested && <span className="project-row__parent">{parentName} › </span>}
          {repo.name}
        </span>
        {showStatus && <span className={`activity-indicator activity-indicator--${live.status}`} aria-hidden="true" />}
        {live && <span className="project-row__count" title={`${live.sessions} open ${live.sessions === 1 ? "tab" : "tabs"}`}>{live.sessions}</span>}
        <button
          type="button"
          className={`project-row__pin ${repo.pinned ? "project-row__pin--on" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleProjectPin(repo);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          title={repo.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          aria-label={repo.pinned ? `Unpin ${repo.name}` : `Pin ${repo.name}`}
          aria-pressed={repo.pinned}
        >
          <Pin size={12} fill={repo.pinned ? "currentColor" : "none"} />
        </button>
      </div>
      {portals}
    </>
  );
}
