import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FolderInput, FolderOpen, Pin, PinOff, Plus, Sparkles, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import type { RepoGroup, RepoInfo } from "../../lib/types";
import { getEditorLabel } from "../../lib/editors";
import { getErrorMessage } from "../../lib/errors";
import { gitCreateWorktree, revealInFinder } from "../../lib/tauri";
import { useEditorStore } from "../../stores/useEditorStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useSkillStore } from "../../stores/useSkillStore";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const EMPTY_SKILLS: never[] = [];

/** Project operations owned by AppShell, shared by the sidebar and Projects page. */
export interface ProjectHandlers {
  /** Resolves to the canonical path, or null if it couldn't be added. */
  onAddProject: (repoPath: string, groupId?: string | null) => Promise<string | null>;
  /** Choose a folder and add it, optionally straight into a group. */
  onPickAndAddProject: (groupId?: string | null) => void;
  onRemoveProject: (repoPath: string) => void;
  onOpenInEditor: (repoPath: string) => void;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
}

type Prompt = { kind: "worktree" | "group"; x: number; y: number };

export function toggleProjectPin(repo: RepoInfo) {
  void useRepoStore.getState().setPinned(repo.path, !repo.pinned).catch((error) => {
    useNoticeStore.getState().pushNotice({
      tone: "error",
      title: repo.pinned ? "Couldn't unpin project" : "Couldn't pin project",
      message: getErrorMessage(error),
    });
  });
}

function slugPreview(value: string) {
  return value
    .trim()
    .split("")
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toggleGroupPin(group: RepoGroup) {
  void useRepoStore.getState().setGroupPinned(group.id, !group.pinned).catch((error) => {
    useNoticeStore.getState().pushNotice({
      tone: "error",
      title: group.pinned ? "Couldn't unpin group" : "Couldn't pin group",
      message: getErrorMessage(error),
    });
  });
}

/** Right-click menu for a project, plus the small naming prompts it opens. */
export function useProjectMenu(repo: RepoInfo, handlers: ProjectHandlers) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const groups = useRepoStore((s) => s.groups);
  const skills = useSkillStore((s) => s.skillsByRepo[repo.path] ?? EMPTY_SKILLS);
  const preferredEditorLabel = getEditorLabel(useEditorStore((s) => s.settings.preferredEditor));
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const closePrompt = useCallback(() => {
    setPrompt(null);
    setPromptValue("");
  }, []);

  useEffect(() => {
    if (!prompt) return;
    const handlePointer = (e: MouseEvent) => {
      if (promptRef.current && !promptRef.current.contains(e.target as Node)) closePrompt();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePrompt();
    };
    document.addEventListener("mousedown", handlePointer, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [prompt, closePrompt]);

  const openMenuAt = useCallback((x: number, y: number) => {
    setMenu({ x, y });
    // Skill state can change outside Shep (agents, git) — re-check on open.
    void useSkillStore.getState().refresh(repo.path);
  }, [repo.path]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY);
  }, [openMenuAt]);

  const openPrompt = (kind: Prompt["kind"]) => {
    setPrompt({ kind, ...(menu ?? { x: 200, y: 200 }) });
    setPromptValue("");
  };

  const handleSubmitPrompt = async () => {
    const value = promptValue.trim();
    if (!prompt || !value || submitting) return;
    setSubmitting(true);
    try {
      if (prompt.kind === "worktree") {
        const created = await gitCreateWorktree(repo.path, value);
        await handlers.onAddProject(created.path, repo.group);
      } else {
        const group = await useRepoStore.getState().createGroup(value);
        await handlers.onMoveToGroup(repo.path, group.id);
      }
      closePrompt();
    } catch (error) {
      pushNotice({
        tone: "error",
        title: prompt.kind === "worktree" ? "Couldn't create worktree" : "Couldn't create group",
        message: getErrorMessage(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const otherGroups = groups.filter((g) => g.id !== repo.group);
  const moveToChildren: ContextMenuItem[] = [
    ...otherGroups.map((g) => ({ label: g.name, onClick: () => void handlers.onMoveToGroup(repo.path, g.id) })),
    ...(otherGroups.length > 0 ? [{ separator: true, label: "_sep_new" }] : []),
    { label: "New Group…", onClick: () => openPrompt("group") },
    ...(repo.group
      ? [
          { separator: true, label: "_sep_remove" },
          { label: "Remove from group", onClick: () => void handlers.onMoveToGroup(repo.path, null) },
        ]
      : []),
  ];

  const skillChildren: ContextMenuItem[] = skills.map((skill) => ({
    label: skill.title,
    icon: <Check size={14} className={skill.installed ? "opacity-100" : "opacity-0"} />,
    keepOpen: true,
    onClick: () => {
      const store = useSkillStore.getState();
      const action = skill.installed ? store.uninstall(repo.path, skill.name) : store.install(repo.path, skill.name);
      void action.catch((error) => {
        pushNotice({
          tone: "error",
          title: skill.installed ? "Couldn't remove agent skill" : "Couldn't add agent skill",
          message: getErrorMessage(error),
        });
      });
    },
  }));

  const menuItems: ContextMenuItem[] = [
    {
      label: repo.pinned ? "Unpin from Sidebar" : "Pin to Sidebar",
      icon: repo.pinned ? <PinOff size={14} /> : <Pin size={14} />,
      onClick: () => toggleProjectPin(repo),
    },
    { separator: true, label: "_sep_pin" },
    {
      label: preferredEditorLabel ? `Open in ${preferredEditorLabel}` : "Set Editor Preference",
      icon: <SquareArrowOutUpRight size={14} />,
      onClick: () => handlers.onOpenInEditor(repo.path),
    },
    {
      label: "Open in Finder",
      icon: <FolderOpen size={14} />,
      onClick: () => {
        revealInFinder(repo.path).catch((error) => {
          pushNotice({ tone: "error", title: "Couldn't open in Finder", message: getErrorMessage(error) });
        });
      },
    },
    {
      label: "Copy Path",
      icon: <Copy size={14} />,
      onClick: () => {
        navigator.clipboard.writeText(repo.path)
          .then(() => pushNotice({ tone: "success", title: "Copied project path", message: repo.path }))
          .catch((error) => pushNotice({ tone: "error", title: "Couldn't copy project path", message: getErrorMessage(error) }));
      },
    },
    { label: "Move to", icon: <FolderInput size={14} />, children: moveToChildren },
    ...(skillChildren.length > 0
      ? [{ label: "Agent Skills", icon: <Sparkles size={14} />, children: skillChildren }]
      : []),
    { label: "Create Worktree", icon: <Plus size={14} />, onClick: () => openPrompt("worktree") },
    {
      label: "Remove Project",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => handlers.onRemoveProject(repo.path),
    },
  ];

  const slug = slugPreview(promptValue);
  const isWorktree = prompt?.kind === "worktree";

  const portals = (
    <>
      {menu && createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
        document.body,
      )}
      {prompt && createPortal(
        <div ref={promptRef} className="context-menu" style={{ left: prompt.x, top: prompt.y, minWidth: 280 }}>
          <div style={{ padding: "6px 10px 2px", fontSize: 11, opacity: 0.5 }}>
            {isWorktree ? "Create worktree" : `New group for ${repo.name}`}
          </div>
          <form
            className="branch-dropdown__create-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmitPrompt();
            }}
            style={{ padding: "8px" }}
          >
            <input
              className="branch-dropdown__input"
              type="text"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={isWorktree ? "feature/my-change" : "Group name"}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              disabled={submitting}
            />
          </form>
          {isWorktree && (
            <div style={{ padding: "0 10px 8px", fontSize: 11, opacity: 0.5, lineHeight: 1.4 }}>
              Creates a new branch and worktree under
              <div style={{ marginTop: 4, opacity: 0.8, wordBreak: "break-all" }}>
                {`.shep-worktrees/${repo.name}/${slug || "..."}`}
              </div>
            </div>
          )}
          <div style={{ padding: "6px 8px" }}>
            <button
              className="btn-primary w-full"
              disabled={!promptValue.trim() || submitting}
              onClick={() => void handleSubmitPrompt()}
            >
              {submitting ? "Creating..." : isWorktree ? "Create Worktree" : "Create Group"}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );

  return { handleContextMenu, openMenuAt, portals };
}
