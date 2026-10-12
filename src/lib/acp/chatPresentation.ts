import type { ChatItem, ChatTurn } from "./chatModel.ts";

/** Keep every answer block after the last tool, including images and links. */
export function splitTurn(turn: ChatTurn): { work: ChatItem[]; answer: ChatItem[] } {
  if (turn.endedAt === null) return { work: [], answer: turn.items };
  let lastTool = -1;
  turn.items.forEach((item, index) => { if (item.kind === "tool") lastTool = index; });
  const work: ChatItem[] = [];
  const answer: ChatItem[] = [];
  turn.items.forEach((item, index) => {
    const visible = item.kind === "notice" || (index > lastTool && (item.kind === "message" || item.kind === "media"));
    (visible ? answer : work).push(item);
  });
  return { work, answer };
}

export function turnStopMessage(turn: ChatTurn): string | null {
  switch (turn.stopReason) {
    case "cancelled": return "Stopped.";
    case "max_tokens": return "Stopped early at the response limit. Say ‘continue’ to keep going.";
    case "max_turn_requests": return "Stopped early at the turn limit. Say ‘continue’ to keep going.";
    case "error": return turn.error ?? null;
    default: return null;
  }
}

export type TextDiffLineKind = "add" | "remove" | "hunk" | "header" | "context";
export interface TextDiffLine { kind: TextDiffLineKind; text: string }

/**
 * Tool output that carries a unified diff as text (Muse's edit tools report
 * edits this way rather than as ACP diff content), split into lines to color.
 * Null for anything that isn't clearly a diff, so ordinary output stays plain.
 */
export function textDiffLines(output: string): TextDiffLine[] | null {
  const lines = output.split("\n");
  const hasHunk = lines.some((line) => line.startsWith("@@"));
  const hasHeaders = lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ "));
  if (!hasHunk && !hasHeaders) return null;
  const parsed = lines.map((text): TextDiffLine => ({
    text,
    kind: text.startsWith("+++ ") || text.startsWith("--- ") ? "header"
      : text.startsWith("@@") ? "hunk"
        : text.startsWith("+") ? "add"
          : text.startsWith("-") ? "remove"
            : "context",
  }));
  return parsed.some((line) => line.kind === "add" || line.kind === "remove") ? parsed : null;
}
