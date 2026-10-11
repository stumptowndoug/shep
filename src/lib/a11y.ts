import type { KeyboardEvent } from "react";

export function handleContextMenuKey(event: KeyboardEvent, openAt: (x: number, y: number) => void): boolean {
  if (event.target !== event.currentTarget || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return false;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  openAt(rect.left, rect.bottom);
  return true;
}

export function handleActionKey(event: KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
