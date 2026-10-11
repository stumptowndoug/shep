import { useState, useEffect } from "react";
import { getMemoryStats } from "../../lib/tauri";

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}`;
}

/**
 * Dev-only memory indicator. Shows Shep's own RSS and the total RSS of all
 * child processes (CLI tools). Only rendered when import.meta.env.DEV is true.
 */
export default function DevMemory() {
  const [app, setApp] = useState(0);
  const [children, setChildren] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const stats = await getMemoryStats();
        if (cancelled) return;
        setApp(stats.app_rss);
        setChildren(stats.children_rss);
      } catch {
        // Silently ignore — command may not exist in production builds
      }
    };

    void poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const total = app + children;
  if (total === 0) return null;

  return (
    <div
      className="flex items-center gap-2 shrink-0 text-[10px] pl-3 border-l border-[var(--glass-border)] opacity-50 select-none font-mono"
      title={`Rust backend: ${formatMB(app)} MB\nTerminal and ACP process trees: ${formatMB(children)} MB\nWebKit and GPU memory are not included.`}
    >
      <span>backend {formatMB(app)}M</span>
      <span className="opacity-40">|</span>
      <span>agents {formatMB(children)}M</span>
    </div>
  );
}
