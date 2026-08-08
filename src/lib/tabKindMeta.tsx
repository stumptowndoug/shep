import { FolderTree, Terminal, SquareTerminal, List, ListTodo } from "lucide-react";
import type { TabKind } from "./types";

export interface TabKindMeta {
  label: string;
  icon: (size: number) => React.ReactNode;
  shortcut?: string;
}

const meta: Record<TabKind, TabKindMeta> = {
  assistant: {
    label: "Agent",
    icon: (size) => <SquareTerminal size={size} />,
    shortcut: "⇧⌘T",
  },
  terminal: {
    label: "Terminal",
    icon: (size) => <Terminal size={size} />,
    shortcut: "⌘T",
  },
  commands: {
    label: "Commands",
    icon: (size) => <List size={size} />,
    shortcut: "⇧⌘C",
  },
  git: {
    label: "Files",
    icon: (size) => <FolderTree size={size} />,
    shortcut: "⌘G",
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

export default meta;
