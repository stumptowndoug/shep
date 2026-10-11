import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, LoaderCircle, Radio, RefreshCcw, Search, Square, X } from "lucide-react";
import { listListeningPorts, killPort, openUrl } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import type { PortInfo } from "../../lib/types";

function formatMemory(kb: number): string {
  if (kb === 0) return "—";
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function PortsPanel() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const requestId = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listListeningPorts();
      if (request === requestId.current) setPorts(result);
    } catch (err) {
      if (request === requestId.current) setError(getErrorMessage(err));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { requestId.current++; };
  }, [refresh]);

  const handleKill = useCallback(async (port: PortInfo) => {
    setKilling((prev) => new Set(prev).add(port.pid));
    try {
      await killPort(port.pid);
      pushNotice({ tone: "success", title: "Process stopped", message: `Stopped ${port.process} (PID ${port.pid}) on port ${port.port}` });
      // Keep the action disabled while the process exits and the list refreshes.
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await refresh();
    } catch (err) {
      pushNotice({ tone: "error", title: "Couldn’t stop process", message: getErrorMessage(err) });
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(port.pid);
        return next;
      });
    }
  }, [pushNotice, refresh]);

  const handleOpenBrowser = useCallback(async (port: number) => {
    try {
      await openUrl(`http://localhost:${port}`);
    } catch (err) {
      pushNotice({ tone: "error", title: "Couldn’t open port", message: getErrorMessage(err) });
    }
  }, [pushNotice]);

  const search = query.trim().toLowerCase();
  const filtered = ports.filter((port) => !search ||
    [port.port, port.pid, port.project, port.process, port.framework, port.cwd]
      .join(" ").toLowerCase().includes(search));
  const grouped = new Map<string, PortInfo[]>();
  for (const port of filtered) {
    const group = port.project || "Other";
    const entries = grouped.get(group) ?? [];
    entries.push(port);
    grouped.set(group, entries);
  }
  const groups = [...grouped].sort(([a], [b]) =>
    Number(a === "Other") - Number(b === "Other") || a.localeCompare(b));
  const projectCount = new Set(ports.map((port) => port.project).filter(Boolean)).size;
  const updateQuery = (value: string) => {
    setQuery(value);
    // Reveal matches when the query changes, while keeping groups collapsible.
    setCollapsed(new Set());
  };
  const clearSearch = () => { updateQuery(""); searchInput.current?.focus(); };

  return (
    <div className="page ports-page">
      <div className="page__heading page__heading--actions">
        <div>
          <h1 className="page__title">Ports.</h1>
          <p className="page__lede">Your running servers, all in one place.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading} aria-label="Refresh port list">
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="ports-page__toolbar">
        <div className="ports-search">
          <Search size={14} aria-hidden="true" />
          <input ref={searchInput} type="text" value={query} onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
            placeholder="Search ports" aria-label="Search ports" autoComplete="off" spellCheck={false} />
          {query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={clearSearch}><X size={13} aria-hidden="true" /></button>}
        </div>
        <p className="ports-page__summary" role="status">
          {loading ? "Scanning…" : error ? "Scan unavailable" : <>
            {ports.length > 0 && <span className="ports-page__live-dot" aria-hidden="true" />}
            <span>{search ? `${filtered.length} of ${ports.length} ports` : `${ports.length} listening`}</span>
            {!search && projectCount > 0 && <span className="ports-page__project-count">{projectCount} {projectCount === 1 ? "project" : "projects"}</span>}
          </>}
        </p>
      </div>

      {error && (
        <div className="callout callout--danger ports-page__error" role="alert">
          <div><strong>Couldn’t scan ports.</strong><p>{error}{ports.length > 0 ? " Showing the last successful scan." : ""}</p></div>
          <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading}>Try again</button>
        </div>
      )}

      {!error && filtered.length === 0 && (
        <div className="ports-empty">
          <span className="ports-empty__icon" aria-hidden="true">{loading ? <LoaderCircle size={22} className="animate-spin" /> : <Radio size={22} />}</span>
          <h2>{loading ? "Looking for servers…" : search ? "No matching ports." : "No local servers."}</h2>
          <p>{loading ? "Scanning the processes listening on this machine." : search ? "Try a port number, project, or process name." : "Start a development server in a project, then refresh this list."}</p>
          {search && !loading && <button type="button" className="btn-ghost" onClick={clearSearch}>Clear search</button>}
        </div>
      )}

      {groups.map(([group, entries]) => {
        const closed = collapsed.has(group);
        return (
          <section key={group} className="port-section" aria-label={`${group} ports`}>
            <h2 className="port-group__heading">
              <button type="button" className="port-group__toggle" aria-expanded={!closed}
                aria-label={`${group}, ${entries.length} ${entries.length === 1 ? "port" : "ports"}`}
                onClick={() => setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (closed) next.delete(group); else next.add(group);
                  return next;
                })}>
                <ChevronDown size={13} aria-hidden="true" />
                <span className="port-group__name">{group}</span>
                <span className="port-group__count">{entries.length}</span>
              </button>
            </h2>
            {!closed && <ul className="port-group">
              {entries.sort((a, b) => a.port - b.port || a.pid - b.pid).map((port) => {
                const stopping = killing.has(port.pid);
                return (
                  <li key={`${port.pid}-${port.port}`} className="port-row" aria-label={`Port ${port.port}, ${port.framework || port.process}`}>
                    <span className="port-row__number" title={`localhost:${port.port}`}>:{port.port}</span>
                    <div className="port-row__body">
                      <div className="port-row__name">
                        <span className="port-row__title" title={port.framework || port.process}>{port.framework || port.process}</span>
                        <span className="port-row__pid">PID {port.pid}</span>
                      </div>
                      <div className="port-row__detail">
                        {port.framework && <span className="port-row__process">{port.process}</span>}
                        <span className="port-row__path" title={port.cwd}>{port.cwd || "Working directory unavailable"}</span>
                      </div>
                    </div>
                    <dl className="port-row__metrics">
                      <div><dt>Memory</dt><dd>{formatMemory(port.memory_kb)}</dd></div>
                      <div><dt>Uptime</dt><dd>{port.uptime.trim() || "—"}</dd></div>
                    </dl>
                    <div className="port-row__actions">
                      <button type="button" className="icon-btn port-row__action" onClick={() => void handleOpenBrowser(port.port)} title={`Open localhost:${port.port}`} aria-label={`Open port ${port.port} in browser`}>
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </button>
                      <button type="button" className="icon-btn port-row__action" onClick={() => void handleKill(port)} disabled={stopping} title={`Stop ${port.process} (PID ${port.pid})`} aria-label={`${stopping ? "Stopping" : "Stop"} process on port ${port.port}`} data-danger="true">
                        {stopping ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Square size={12} fill="currentColor" aria-hidden="true" />}
                      </button>
                    </div>
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
