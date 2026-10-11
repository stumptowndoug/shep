import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Clock3, LoaderCircle, RefreshCcw, Search, X } from "lucide-react";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { getErrorMessage } from "../../lib/errors";
import { checkCommandExists, listSessionHistory } from "../../lib/tauri";
import { chatAdapterAvailable } from "../../lib/acp/adapters";
import type { SessionHistoryEntry } from "../../lib/types";
import { sessionResumeInterface, supportsSessionResume } from "../../lib/sessionResume";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { groupSessionHistory } from "../../lib/sessionHistory";
import OptionGroup from "../shared/OptionGroup";

type HistoryScope = "project" | "all";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
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
  const [searchQuery, setSearchQuery] = useState("");
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableProviders, setAvailableProviders] = useState<Record<string, { terminal: boolean; chat: boolean }>>({});
  const [resumingKey, setResumingKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searchInput = useRef<HTMLInputElement>(null);
  const loadRequestId = useRef(0);
  const projectState = useTerminalStore((state) => state.projectState);
  const tabActivity = useTerminalStore((state) => state.tabActivity);

  useEffect(() => {
    if (!activeRepoPath && scope === "project") setScope("all");
  }, [activeRepoPath, scope]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadSessions = useCallback(async () => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const projectPath = scope === "project" ? activeRepoPath : null;
      const nextSessions = await listSessionHistory(projectPath, searchQuery || null, 200);
      if (loadRequestId.current === requestId) setSessions(nextSessions);
    } catch (loadError) {
      if (loadRequestId.current === requestId) setError(getErrorMessage(loadError));
    } finally {
      if (loadRequestId.current === requestId) setLoading(false);
    }
  }, [activeRepoPath, scope, searchQuery]);

  useEffect(() => {
    void loadSessions();
    return () => { loadRequestId.current++; };
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      CODING_ASSISTANTS.map(async (assistant) => {
        const [terminal, chat] = await Promise.all([
          checkCommandExists(assistant.command).catch(() => false),
          assistant.acp ? chatAdapterAvailable(assistant.acp) : Promise.resolve(false),
        ]);
        return [assistant.id, { terminal, chat }] as const;
      }),
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

  const selectedProjectName = activeRepoPath ? projectName(activeRepoPath) : null;
  const knownProjects = useMemo(() => new Set(knownRepoPaths), [knownRepoPaths]);
  const groups = groupSessionHistory(sessions);
  const updateQuery = (value: string) => {
    setQuery(value);
    setCollapsed(new Set());
  };
  const clearSearch = () => { updateQuery(""); searchInput.current?.focus(); };

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
    <div className="page history-page">
      <header className="page__heading page__heading--actions">
        <div>
          <h1 className="page__title">History.</h1>
          <p className="page__lede">Pick up where you left off.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void loadSessions()}
          disabled={loading} aria-label="Refresh session history">
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          Refresh
        </button>
      </header>

      <div className="history-panel__controls">
        <div className="history-search">
          <Search size={14} aria-hidden="true" />
          <input ref={searchInput} type="text" value={query} onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
            placeholder="Search sessions" aria-label="Search session history" autoComplete="off" spellCheck={false} />
          {query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={clearSearch}><X size={13} aria-hidden="true" /></button>}
        </div>
        <OptionGroup<HistoryScope> label="History scope" value={scope}
          onChange={(value) => { setScope(value); setCollapsed(new Set()); }}
          options={[
            { value: "all", label: "All sessions" },
            { value: "project", label: "Project", disabled: !activeRepoPath,
              title: activeRepoPath ? `Show sessions for ${selectedProjectName}` : "Select a project first" },
          ]} />
        <p className="history-panel__summary" role="status">
          {loading || query.trim() !== searchQuery ? "Searching…" : error ? "History unavailable" :
            `${sessions.length === 200 ? "Latest " : ""}${sessions.length} ${searchQuery ? "matching " : ""}${sessions.length === 1 ? "session" : "sessions"}`}
        </p>
      </div>

      {error && (
        <div className="callout callout--danger history-page__error" role="alert">
          <div><strong>Couldn’t load history.</strong><p>{error}</p></div>
          <button type="button" className="btn-secondary" onClick={() => void loadSessions()} disabled={loading}>Try again</button>
        </div>
      )}

      {!error && sessions.length === 0 && (
        <div className="history-empty">
          <span className="history-empty__icon" aria-hidden="true">{loading ? <LoaderCircle size={22} className="animate-spin" /> : <Clock3 size={22} />}</span>
          <h2>{loading ? "Looking for sessions…" : searchQuery ? "No matching sessions." : "No saved sessions yet."}</h2>
          <p>{loading ? "Loading your recent conversations." : searchQuery ? "Try a title, provider, project, or model." :
            scope === "project" ? `Conversations from ${selectedProjectName} will appear here.` : "Start an agent in a project. Your conversations will appear here so you can return to them."}</p>
          {searchQuery && !loading && <button type="button" className="btn-ghost" onClick={clearSearch}>Clear search</button>}
        </div>
      )}

      {!error && groups.map((group) => {
        const closed = collapsed.has(group.label);
        return (
          <section className="history-section" key={group.label} aria-label={`${group.label} sessions`}>
            <h2 className="history-group__heading">
              <button type="button" className="history-group__toggle" aria-expanded={!closed}
                aria-label={`${group.label}, ${group.sessions.length} ${group.sessions.length === 1 ? "session" : "sessions"}`}
                onClick={() => setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (closed) next.delete(group.label); else next.add(group.label);
                  return next;
                })}>
                <ChevronDown size={13} aria-hidden="true" />
                <span className="history-group__name">{group.label}</span>
                <span className="history-group__count">{group.sessions.length}</span>
              </button>
            </h2>
            {!closed && <ul className="history-list" aria-label={`${group.label} conversations`}>
              {group.sessions.map((session) => {
                const key = sessionKey(session.provider, session.sessionId);
                const isActive = activeSessions.has(key);
                const logoSrc = assistantLogoSrc[session.provider];
                const providerAvailable = availableProviders[session.provider];
                const canResume = providerAvailable && sessionResumeInterface(session, providerAvailable) !== null;
                const disabledReason = isActive ? null
                  : !supportsSessionResume(session.provider) ? "This provider does not support resume yet"
                  : providerAvailable === undefined ? "Checking whether the agent is installed"
                  : !canResume ? `Set up ${providerLabel(session.provider)}${session.agentInterface === "chat" ? " chat" : ""} in a new tab first`
                  : !knownProjects.has(session.projectPath) ? "Add this project to Shep before resuming"
                  : null;
                const isResuming = resumingKey === key;
                return (
                  <li key={key} className="history-row">
                    <div className="history-row__logo" aria-hidden="true">
                      {logoSrc ? <img src={logoSrc} alt="" className={getAssistantLogoClass(session.provider)} /> : <Clock3 size={18} />}
                    </div>
                    <div className="history-row__body">
                      <div className="history-row__heading">
                        <span className="history-row__title session-title-output" title={session.title ?? "Untitled session"}>
                          {session.title ?? "Untitled session"}
                        </span>
                        {isActive && <span className="history-row__status">Active</span>}
                      </div>
                      <div className="history-row__meta">
                        <span className="history-row__provider">{providerLabel(session.provider)}</span>
                        <span className="history-row__project" title={session.projectPath}>{projectName(session.projectPath)}</span>
                        {session.model && <span className="history-row__model" title={session.model}>{session.model}</span>}
                      </div>
                    </div>
                    <div className="history-row__time" title={`Started ${formatStartedAt(session.startedAt)} · Last active ${formatStartedAt(session.lastActivityAt)}`}>
                      <time dateTime={new Date(session.lastActivityAt).toISOString()}>{formatRelativeTime(session.lastActivityAt)}</time>
                      <span>{isActive ? "In this window" : "Last active"}</span>
                    </div>
                    <button type="button" className="icon-btn history-row__action" onClick={() => void handleResume(session)}
                      disabled={Boolean(disabledReason) || Boolean(resumingKey)}
                      title={disabledReason ?? (isActive ? "Open active session" : "Resume saved session")}
                      aria-label={`${isActive ? "Open" : "Resume"} ${session.title ?? "untitled session"}`}>
                      {isResuming ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                        : <ArrowUpRight size={15} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>}
          </section>
        );
      })}
    </div>
  );
}
