import type { ChatItem, ChatTurn, ToolDiff } from "./chatModel.ts";

/** Keep every answer block after the last tool, including images and links.
 *  The rest is work, grouped under one row while the turn runs and after. */
export function splitTurn(turn: ChatTurn): { work: ChatItem[]; answer: ChatItem[] } {
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

/** Rough +/- line counts for a diff summary. */
export function diffStats(diffs: ToolDiff[]) {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    if (diff.truncated) continue;
    const before = new Set((diff.oldText ?? "").split("\n"));
    const after = new Set(diff.newText.split("\n"));
    for (const line of after) if (!before.has(line)) added += 1;
    for (const line of before) if (line && !after.has(line)) removed += 1;
  }
  return { added, removed };
}

export interface FileChange {
  path: string;
  diffs: ToolDiff[];
  added: number;
  removed: number;
}

/** Files a turn changed, in the order it first touched them, with their diffs
 * and combined line counts. Failed edits didn't change anything. */
export function turnChanges(turn: ChatTurn): FileChange[] {
  const byPath = new Map<string, ToolDiff[]>();
  for (const item of turn.items) {
    if (item.kind !== "tool" || item.status === "failed") continue;
    for (const diff of item.diffs) byPath.set(diff.path, [...(byPath.get(diff.path) ?? []), diff]);
  }
  return [...byPath].map(([path, diffs]) => ({ path, diffs, ...diffStats(diffs) }));
}

/** A path as shown in a project: relative when inside it. */
export function projectRelativePath(path: string, repoPath: string): string {
  const root = repoPath.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** A limit is something to wait out, not a breakage: show it as a warning. */
const LIMIT_ERROR = /rate[ -]?limit|usage limit|quota|too many requests|\b429\b|overloaded|credit balance|out of credits/i;

export function errorTone(text: string): "warning" | "error" {
  return LIMIT_ERROR.test(text) ? "warning" : "error";
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
