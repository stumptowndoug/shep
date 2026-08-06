import type { Terminal } from "@xterm/xterm";

/** Distance of the viewport from the bottom of the scrollback, in lines.
 *  0 means pinned to the bottom (following output). */
export function terminalBottomOffset(term: Terminal): number {
  const buffer = term.buffer.active;
  return Math.max(0, buffer.baseY - buffer.viewportY);
}

export function preserveTerminalViewport(term: Terminal, update: () => void) {
  const bottomOffset = terminalBottomOffset(term);

  update();

  if (bottomOffset === 0) {
    term.scrollToBottom();
    return;
  }

  const after = term.buffer.active;
  term.scrollToLine(Math.max(0, after.baseY - bottomOffset));
}

/** Re-assert a scroll position onto the DOM viewport after the terminal's
 *  container was `display:none`. Browsers zero a hidden element's scrollTop
 *  and never restore it, while xterm's internal position survives — and
 *  xterm ignores scroll requests that already match its internal position,
 *  so a plain scrollToLine would no-op and leave the DOM stuck at the top.
 *  Jumping elsewhere first forces a real scroll; both calls land within one
 *  render frame, so the intermediate position is never painted. A pinned
 *  viewport must finish with scrollToBottom(), which clears xterm's internal
 *  user-scrolling latch. */
export function resyncTerminalViewport(term: Terminal, bottomOffset: number): void {
  const buffer = term.buffer.active;
  if (buffer.baseY === 0) return;

  const target = Math.max(0, buffer.baseY - bottomOffset);
  if (bottomOffset === 0) {
    term.scrollToLine(0);
    term.scrollToBottom();
  } else {
    term.scrollToLine(target === 0 ? buffer.baseY : 0);
    term.scrollToLine(target);
  }
}
