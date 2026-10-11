import type { SessionHistoryEntry } from "./types";

export function groupSessionHistory(sessions: SessionHistoryEntry[], now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const groups = [
    { label: "Today", since: today.getTime(), sessions: [] as SessionHistoryEntry[] },
    { label: "Yesterday", since: yesterday.getTime(), sessions: [] as SessionHistoryEntry[] },
    { label: "Previous 7 days", since: weekAgo.getTime(), sessions: [] as SessionHistoryEntry[] },
    { label: "Earlier", since: -Infinity, sessions: [] as SessionHistoryEntry[] },
  ];
  for (const session of [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    groups.find((group) => session.lastActivityAt >= group.since)!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
