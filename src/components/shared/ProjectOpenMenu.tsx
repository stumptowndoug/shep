import { FolderOpen, Plus } from "lucide-react";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import EditorIcon from "./EditorIcon";
import tabKindMeta from "../../lib/tabKindMeta";
import { getEditorLabel } from "../../lib/editors";
import { useEditorStore } from "../../stores/useEditorStore";
import type { ProjectActionKind } from "../../lib/types";

export type ProjectOpenKind = Exclude<ProjectActionKind, "assistant">;

/** Everything besides an agent that the active project can open. */
export interface ProjectOpenActions {
  open: (kind: ProjectOpenKind) => void;
  openInEditor: () => void;
  revealInFinder: () => void;
}

const OPEN_KINDS: ProjectOpenKind[] = ["terminal", "commands", "git", "todos"];

interface ProjectOpenMenuProps {
  x: number;
  y: number;
  actions: ProjectOpenActions;
  onClose: () => void;
  anchor?: HTMLElement | null;
  /** Leads with New agent, for menus that stand in for the + button. */
  onNewAgent?: () => void;
}

/** Shared by the sidebar's More button and the tab bar's + menu. */
export default function ProjectOpenMenu({ x, y, actions, onClose, anchor, onNewAgent }: ProjectOpenMenuProps) {
  const editorLabel = getEditorLabel(useEditorStore((s) => s.settings.preferredEditor));
  const items: ContextMenuItem[] = [
    ...(onNewAgent ? [
      { label: tabKindMeta.launcher.label, icon: <Plus size={14} />, shortcut: tabKindMeta.launcher.shortcut, onClick: onNewAgent },
      { label: "", separator: true },
    ] : []),
    ...OPEN_KINDS.map((kind) => ({
      label: tabKindMeta[kind].label,
      icon: tabKindMeta[kind].icon(14),
      shortcut: tabKindMeta[kind].shortcut,
      onClick: () => actions.open(kind),
    })),
    { label: "", separator: true },
    {
      label: editorLabel ? `Open in ${editorLabel}` : "Open in editor…",
      icon: <EditorIcon size={14} />,
      shortcut: "⌘E",
      onClick: actions.openInEditor,
    },
    { label: "Show in Finder", icon: <FolderOpen size={14} />, onClick: actions.revealInFinder },
  ];
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} label="Open in this project" anchor={anchor} />;
}
