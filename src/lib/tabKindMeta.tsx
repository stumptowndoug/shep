import { FolderTree, Terminal, SquareTerminal, List, ListTodo, ExternalLink } from "lucide-react";
import { isMac } from "./platform";
import type { TabKind } from "./types";

export interface TabKindMeta {
  label: string;
  icon: (size: number) => React.ReactNode;
  shortcut?: string;
}

// Windows chords all use Ctrl+Shift (plain Ctrl+letter is a terminal control
// character) and must match the keydown handler in AppShell.tsx.
const meta: Record<TabKind, TabKindMeta> = {
  assistant: {
    label: "Agent",
    icon: (size) => <SquareTerminal size={size} />,
    shortcut: isMac ? "⇧⌘T" : "Ctrl+Shift+A",
  },
  terminal: {
    label: "Terminal",
    icon: (size) => <Terminal size={size} />,
    shortcut: isMac ? "⌘T" : "Ctrl+Shift+T",
  },
  commands: {
    label: "Commands",
    icon: (size) => <List size={size} />,
    shortcut: isMac ? "⇧⌘C" : "Ctrl+Shift+M",
  },
  git: {
    label: "Files",
    icon: (size) => <FolderTree size={size} />,
    shortcut: isMac ? "⌘G" : "Ctrl+Shift+G",
  },
  launcher: {
    label: "New Agent",
    icon: (size) => <SquareTerminal size={size} />,
  },
  todos: {
    label: "To-dos",
    icon: (size) => <ListTodo size={size} />,
  },
};

/** Extra actions shown in the + menu but not tab kinds */
export const extraActions = {
  openInEditor: {
    label: "Open in Editor",
    icon: (size: number) => <ExternalLink size={size} />,
    shortcut: isMac ? "⌘E" : "Ctrl+Shift+E",
  },
} as const;

export default meta;
