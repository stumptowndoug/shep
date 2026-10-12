import { FileDiff, Terminal, SquarePen, SquarePlus, List, ListTodo } from "lucide-react";
import type { TabKind } from "./types";

export interface TabKindMeta {
  label: string;
  icon: (size: number) => React.ReactNode;
  shortcut?: string;
}

const meta: Record<TabKind, TabKindMeta> = {
  assistant: {
    label: "Agent",
    icon: (size) => <SquarePen size={size} />,
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
    label: "Changes",
    icon: (size) => <FileDiff size={size} />,
    shortcut: "⌘G",
  },
  launcher: {
    label: "New agent",
    icon: (size) => <SquarePlus size={size} />,
    shortcut: "⇧⌘T",
  },
  todos: {
    label: "To-dos",
    icon: (size) => <ListTodo size={size} />,
  },
};

export default meta;
