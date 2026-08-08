const SESSION_RESUME_ARGS: Record<string, (sessionId: string) => string[]> = {
  claude: (sessionId) => ["--resume", sessionId],
  codex: (sessionId) => ["resume", sessionId],
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
