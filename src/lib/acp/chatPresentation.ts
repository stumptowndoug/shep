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
