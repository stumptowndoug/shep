import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Clock3, LoaderCircle, RefreshCcw, Search } from "lucide-react";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { getErrorMessage } from "../../lib/errors";
import { checkCommandExists, listSessionHistory } from "../../lib/tauri";
import type { SessionHistoryEntry } from "../../lib/types";
import { supportsSessionResume } from "../../lib/sessionResume";
import { useTerminalStore } from "../../stores/useTerminalStore";

type HistoryScope = "project" | "all";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
};

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsed < minute) return "just now";
  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return `${minutes}m ago`;
  }
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return `${hours}h ago`;
  }
  if (elapsed < 7 * day) {
    const days = Math.floor(elapsed / day);
    return `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(timestamp);
}

function formatStartedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function sessionKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

interface HistoryPanelProps {
  activeRepoPath: string | null;
  knownRepoPaths: string[];
  onResumeSession: (session: SessionHistoryEntry) => Promise<boolean>;
}

export default function HistoryPanel({
  activeRepoPath,
  knownRepoPaths,
  onResumeSession,
}: HistoryPanelProps) {
  const [scope, setScope] = useState<HistoryScope>("all");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableProviders, setAvailableProviders] = useState<Record<string, boolean>>({});
  const [resumingKey, setResumingKey] = useState<string | null>(null);
  const projectState = useTerminalStore((state) => state.projectState);
  const tabActivity = useTerminalStore((state) => state.tabActivity);

  useEffect(() => {
    if (!activeRepoPath && scope === "project") setScope("all");
  }, [activeRepoPath, scope]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectPath = scope === "project" ? activeRepoPath : null;
      setSessions(await listSessionHistory(projectPath, 200));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [activeRepoPath, scope]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      CODING_ASSISTANTS.map(async (assistant) => [
        assistant.id,
        await checkCommandExists(assistant.command).catch(() => false),
      ] as const),
    ).then((results) => {
      if (!cancelled) setAvailableProviders(Object.fromEntries(results));
    });
    return () => { cancelled = true; };
  }, []);

  const activeSessions = useMemo(() => {
    const keys = new Set<string>();
    for (const project of Object.values(projectState)) {
      for (const tab of project.tabs) {
        if (
          tab.kind === "assistant" &&
          tab.assistantId &&
          tab.providerSessionId &&
          tabActivity[tab.ptyId]?.alive
        ) {
          keys.add(sessionKey(tab.assistantId, tab.providerSessionId));
        }
      }
    }
    return keys;
  }, [projectState, tabActivity]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      [
        session.title,
        providerLabel(session.provider),
        session.provider,
        projectName(session.projectPath),
        session.projectPath,
        session.model,
      ].some((value) => value?.toLocaleLowerCase().includes(needle)),
    );
  }, [query, sessions]);

  const selectedProjectName = activeRepoPath ? projectName(activeRepoPath) : null;
  const knownProjects = useMemo(() => new Set(knownRepoPaths), [knownRepoPaths]);

  const handleResume = useCallback(async (session: SessionHistoryEntry) => {
    const key = sessionKey(session.provider, session.sessionId);
    setResumingKey(key);
    try {
      await onResumeSession(session);
    } finally {
      setResumingKey(null);
    }
  }, [onResumeSession]);

  return (
    <div className="history-panel absolute inset-0 overflow-y-auto">
      <header className="history-panel__header">
        <div>
          <h2 className="history-panel__title">Session history</h2>
          <p className="history-panel__description">
            Find conversations Shep has seen. Resume actions are coming next.
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void loadSessions()}
          disabled={loading}
          title="Refresh session history"
          aria-label="Refresh session history"
        >
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="history-panel__controls">
        <div className="history-scope" role="group" aria-label="History scope">
          <button
            type="button"
            className={`history-scope__button ${scope === "all" ? "history-scope__button--active" : ""}`}
            onClick={() => setScope("all")}
          >
            All sessions
          </button>
          <button
            type="button"
            className={`history-scope__button ${scope === "project" ? "history-scope__button--active" : ""}`}
            onClick={() => setScope("project")}
            disabled={!activeRepoPath}
            title={activeRepoPath ? `Show sessions for ${selectedProjectName}` : "Select a project first"}
          >
            Project
          </button>
        </div>

        <label className="history-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, provider, repo, or model"
            aria-label="Search session history"
          />
        </label>
      </div>

      <div className="history-panel__summary">
        <span>
          {scope === "project" && selectedProjectName ? selectedProjectName : "All projects"}
        </span>
        {!loading && !error && (
          <span>{filteredSessions.length}{query.trim() ? ` of ${sessions.length}` : ""} sessions</span>
        )}
      </div>

      {error && (
        <div className="history-state history-state--error">
          <strong>Couldn’t load session history</strong>
          <span>{error}</span>
        </div>
      )}

      {!error && loading && sessions.length === 0 && (
        <div className="history-state">
          <Clock3 size={20} />
          <span>Loading saved sessions…</span>
        </div>
      )}

      {!error && !loading && filteredSessions.length === 0 && (
        <div className="history-state">
          <Clock3 size={20} />
          <strong>{query.trim() ? "No matching sessions" : "No saved sessions yet"}</strong>
          <span>
            {query.trim()
              ? "Try a title, provider, repository, or model."
              : "New agent sessions appear here after Shep discovers their provider session ID."}
          </span>
        </div>
      )}

      {!error && filteredSessions.length > 0 && (
        <div className="history-list" role="list" aria-label="Saved agent sessions">
          {filteredSessions.map((session) => {
            const key = sessionKey(session.provider, session.sessionId);
            const isActive = activeSessions.has(key);
            const logoSrc = assistantLogoSrc[session.provider];
            const providerAvailable = availableProviders[session.provider];
            const disabledReason = isActive
              ? null
              : !supportsSessionResume(session.provider)
                ? "This provider does not support resume yet"
                : providerAvailable === undefined
                  ? "Checking whether the CLI is installed"
                  : !providerAvailable
                    ? `${providerLabel(session.provider)} CLI is not installed`
                    : !knownProjects.has(session.projectPath)
                      ? "Add this project to Shep before resuming"
                      : null;
            const isResuming = resumingKey === key;
            return (
              <article
                key={key}
                className="history-row"
                role="listitem"
              >
                <div className="history-row__logo" aria-hidden="true">
                  {logoSrc ? (
                    <img
                      src={logoSrc}
                      alt=""
                      className={getAssistantLogoClass(session.provider)}
                    />
                  ) : (
                    <Clock3 size={15} />
                  )}
                </div>

                <div className="history-row__body">
                  <div className="history-row__heading">
                    <strong className="history-row__title session-title-output">
                      {session.title ?? "untitled session"}
                    </strong>
                    <span className={`history-row__status ${isActive ? "history-row__status--active" : ""}`}>
                      {isActive ? "Active" : "Saved"}
                    </span>
                  </div>
                  <div className="history-row__meta">
                    <span>{providerLabel(session.provider)}</span>
                    <span aria-hidden="true">·</span>
                    <span title={session.projectPath}>{projectName(session.projectPath)}</span>
                    {session.model && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{session.model}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="history-row__aside">
                  <div className="history-row__time" title={`Started ${formatStartedAt(session.startedAt)}`}>
                    <span>{formatRelativeTime(session.lastActivityAt)}</span>
                    <span>{session.endedAt ? "ended" : isActive ? "in this window" : "last active"}</span>
                  </div>
                  <button
                    type="button"
                    className="history-row__action"
                    onClick={() => void handleResume(session)}
                    disabled={Boolean(disabledReason) || Boolean(resumingKey)}
                    title={disabledReason ?? (isActive ? "Open active session" : "Resume saved session")}
                    aria-label={isActive
                      ? `Open ${session.title ?? "active session"}`
                      : `Resume ${session.title ?? "saved session"}`}
                  >
                    {isResuming ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : (
                      <>
                        <span>{isActive ? "Open" : "Resume"}</span>
                        <ChevronRight size={13} />
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
