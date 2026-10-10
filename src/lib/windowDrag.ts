import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE = "button, a, input, textarea, select, [role='button'], [role='menuitem'], .tab";

/**
 * Title-bar behavior for custom chrome: drag the window from empty space,
 * double-click to zoom. Clicks on controls inside the bar are ignored.
 */
export function startWindowDrag(event: React.MouseEvent) {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
  const win = getCurrentWindow();
  if (event.detail === 2) void win.toggleMaximize();
  else void win.startDragging();
}
