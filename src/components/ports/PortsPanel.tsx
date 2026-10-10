import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Square, ExternalLink, Folder } from "lucide-react";
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

function formatUptime(raw: string): string {
  if (!raw) return "—";
  return raw.trim();
}

export default function PortsPanel() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listListeningPorts();
      setPorts(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      if (import.meta.env.DEV) console.error("Port scan failed:", msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once when panel mounts
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleKill = useCallback(async (port: PortInfo) => {
    setKilling((prev) => new Set(prev).add(port.pid));
    try {
      await killPort(port.pid);
      pushNotice({
        tone: "success",
        title: "Process killed",
        message: `Stopped ${port.process} (pid ${port.pid}) on port ${port.port}`,
      });
      window.setTimeout(() => void refresh(), 500);
    } catch (err) {
      pushNotice({
        tone: "error",
        title: "Kill failed",
        message: getErrorMessage(err),
      });
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(port.pid);
        return next;
      });
    }
  }, [pushNotice, refresh]);

  const handleOpenBrowser = useCallback((port: number) => {
    void openUrl(`http://localhost:${port}`);
  }, []);

  // Group by project
  const grouped = ports.reduce<Record<string, PortInfo[]>>((acc, port) => {
    const key = port.project || "Other";
    (acc[key] ??= []).push(port);
    return acc;
  }, {});

  const groupKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="page">
      <div className="page__heading page__heading--actions">
        <div>
          <div className="page__eyebrow">Local servers</div>
          <h1 className="page__title">Ports.</h1>
          <p className="page__lede">Local servers running across your projects.</p>
        </div>
        <button
          className="icon-btn"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh port list"
        >
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="callout callout--danger mb-4 !block">
          <p className="font-medium mb-1">Scan error</p>
          <p className="opacity-70 font-mono text-xs">{error}</p>
        </div>
      )}

      {!error && ports.length === 0 && !loading && (
        <p className="text-sm opacity-50 mt-8 text-center">
          No dev ports detected
        </p>
      )}

      {!error && ports.length === 0 && loading && (
        <p className="text-sm opacity-50 mt-8 text-center">
          Scanning ports...
        </p>
      )}

      {groupKeys.map((group) => (
        <section key={group} className="settings-section">
          <div className="port-group__heading">
            <Folder size={12} />
            <span className="page__label !mb-0">{group}</span>
            <span className="text-xs opacity-50">({grouped[group].length})</span>
          </div>

          <div className="port-group">
            {grouped[group].map((port) => (
              <div
                key={`${port.pid}-${port.port}`}
                className="port-row"
              >
                <span
                  className="font-mono text-sm font-semibold shrink-0"
                  style={{ minWidth: "52px" }}
                >
                  :{port.port}
                </span>

                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm truncate">{port.process}</span>
                    {port.framework && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "var(--surface-active)" }}
                      >
                        {port.framework}
                      </span>
                    )}
                  </div>
                  {port.cwd && (
                    <span className="port-row__path">{port.cwd}</span>
                  )}
                </div>

                <div className="port-row__metrics">
                  <span title="Uptime">{formatUptime(port.uptime)}</span>
                  <span title="Memory">{formatMemory(port.memory_kb)}</span>
                  <span title="Process ID">PID {port.pid}</span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="icon-btn"
                    onClick={() => handleOpenBrowser(port.port)}
                    title={`Open localhost:${port.port}`}
                    aria-label={`Open port ${port.port} in browser`}
                  >
                    <ExternalLink size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => void handleKill(port)}
                    disabled={killing.has(port.pid)}
                    title={`Kill ${port.process} (pid ${port.pid})`}
                    aria-label={`Kill process on port ${port.port}`}
                    data-danger="true"
                  >
                    <Square size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
