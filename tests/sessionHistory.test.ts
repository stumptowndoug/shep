import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSessionHistory } from "../src/lib/sessionHistory.ts";
import type { SessionHistoryEntry } from "../src/lib/types.ts";

const session = (id: string, at: Date): SessionHistoryEntry => ({
  provider: "claude", sessionId: id, projectPath: "/project", title: id, model: null,
  startedAt: at.getTime() - 60_000, lastActivityAt: at.getTime(), endedAt: null,
});

test("groups by local calendar dates across a daylight-saving boundary", () => {
  const now = new Date(2026, 2, 9, 0, 15);
  const groups = groupSessionHistory([
    session("yesterday", new Date(2026, 2, 8, 0, 10)),
    session("today", new Date(2026, 2, 9, 0, 0)),
    session("week", new Date(2026, 2, 3, 0, 0)),
    session("earlier", new Date(2026, 2, 2, 23, 59)),
  ], now.getTime());
  assert.deepEqual(groups.map(group => [group.label, group.sessions.map(item => item.sessionId)]), [
    ["Today", ["today"]], ["Yesterday", ["yesterday"]],
    ["Previous 7 days", ["week"]], ["Earlier", ["earlier"]],
  ]);
});

test("orders recent activity first without mutating search results, and omits empty groups", () => {
  const now = new Date(2026, 9, 10, 12);
  const sessions = [session("older", new Date(2026, 9, 10, 8)), session("newer", now)];
  const groups = groupSessionHistory(sessions, now.getTime());
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessions.map(item => item.sessionId), ["newer", "older"]);
  assert.deepEqual(sessions.map(item => item.sessionId), ["older", "newer"]);
  assert.deepEqual(groupSessionHistory([], now.getTime()), []);
});
