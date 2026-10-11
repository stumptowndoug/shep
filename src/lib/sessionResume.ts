import type { AgentInterface, SessionHistoryEntry } from "./types";

const SESSION_RESUME_ARGS: Record<string, (sessionId: string) => string[]> = {
  claude: (sessionId) => ["--resume", sessionId],
  codex: (sessionId) => ["resume", sessionId],
  cursor: (sessionId) => ["--resume", sessionId],
  antigravity: (sessionId) => ["--conversation", sessionId],
  opencode: (sessionId) => ["--session", sessionId],
  pi: (sessionId) => ["--session", sessionId],
};

export function sessionResumeArgs(provider: string, sessionId: string): string[] | null {
  const buildArgs = SESSION_RESUME_ARGS[provider];
  return buildArgs ? buildArgs(sessionId) : null;
}

export function supportsSessionResume(provider: string): boolean {
  return provider in SESSION_RESUME_ARGS;
}
/** Chat and CLI session stores can differ, so a known interface must never be substituted. */
export function sessionResumeInterface(
  session: Pick<SessionHistoryEntry, "agentInterface">,
  preferred: AgentInterface,
  available: { chat: boolean; terminal: boolean },
): AgentInterface | null {
  if (session.agentInterface) return available[session.agentInterface] ? session.agentInterface : null;
  if (preferred === "chat" && available.chat) return "chat";
  return available.terminal ? "terminal" : available.chat ? "chat" : null;
}
