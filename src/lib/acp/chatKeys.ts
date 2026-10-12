/** Terminal habits that mean the same thing in chat. */

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Esc, or Ctrl+C as in a terminal (copy is ⌘C on macOS, so Ctrl+C is free). */
export function isStopShortcut(event: KeyLike): boolean {
  if (event.metaKey || event.altKey) return false;
  if (event.key === "Escape") return !event.ctrlKey;
  return event.ctrlKey && event.key.toLowerCase() === "c";
}

/** Prompts sent in this chat, oldest first, for ↑/↓ recall in the composer. */
export function sentPrompts(turns: readonly { prompt: string | null; additionalPrompts?: readonly string[] }[]): string[] {
  return turns.flatMap((turn) => [turn.prompt, ...(turn.additionalPrompts ?? [])]
    .filter((prompt): prompt is string => Boolean(prompt?.trim())));
}

/**
 * Step through sent prompts like a shell. `index` counts back from the newest
 * (0 = newest, null = not recalling). Returns the new index and text, or null
 * when the key should keep its normal caret behavior.
 */
export function recallStep(
  prompts: readonly string[],
  index: number | null,
  direction: "older" | "newer",
): { index: number | null; text: string } | null {
  if (direction === "older") {
    const next = index === null ? 0 : index + 1;
    if (next >= prompts.length) return null;
    return { index: next, text: prompts[prompts.length - 1 - next] };
  }
  if (index === null) return null;
  if (index === 0) return { index: null, text: "" };
  return { index: index - 1, text: prompts[prompts.length - index] };
}

const CHAT_HINT_KEY = "shep.chatHint.done";

/** Whether the launcher's "New: Chat" hint was tried or dismissed. */
export function chatHintDone(): boolean {
  try {
    return window.localStorage.getItem(CHAT_HINT_KEY) === "1";
  } catch {
    // Without storage the hint would reappear forever; don't show it at all.
    return true;
  }
}

export function markChatHintDone(): void {
  try {
    window.localStorage.setItem(CHAT_HINT_KEY, "1");
  } catch { /* ignore */ }
}
