import type { ProviderUsageSnapshot, UsageProvider, UsageWindowSnapshot } from "../../lib/types";

const WINDOW_PRIORITY = ["5h", "7d", "30d"];

export function getPrimaryWindow(snapshot: ProviderUsageSnapshot | null): UsageWindowSnapshot | null {
  if (!snapshot) return null;
  for (const window of WINDOW_PRIORITY) {
    const match = snapshot.summaryWindows.find((entry) => entry.window === window);
    if (match) return match;
  }
  return snapshot.summaryWindows[0] ?? null;
}

export function getProviderLabel(provider: UsageProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "OpenCode";
  }
}

export function formatPercent(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value)}%`;
}

export function formatTokenCount(value: number | null): string {
  if (value == null) return "n/a";
  if (value >= 1_000_000_000) return `${Math.round(value / 1_000_000_000)}B`;
  if (value >= 100_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${value}`;
}

export function formatCost(value: number | null): string {
  if (value == null) return "";
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value > 0) return "<$0.01";
  return "$0";
}

export function formatReset(resetAt: string | null): string {
  if (!resetAt) return "No reset";

  const millis = Number(resetAt);
  const target = Number.isFinite(millis) ? new Date(millis * 1000) : new Date(resetAt);
  if (Number.isNaN(target.getTime())) return "No reset";

  const diffMs = target.getTime() - Date.now();
  const clamped = Math.max(diffMs, 0);
  const totalMinutes = Math.floor(clamped / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function usageTone(window: UsageWindowSnapshot | null): "low" | "medium" | "high" | "critical" | "local" {
  if (!window) return "local";
  if (window.usedPercent == null) return "local";
  if (window.usedPercent >= 90) return "critical";
  if (window.usedPercent >= 75) return "high";
  if (window.usedPercent >= 50) return "medium";
  return "low";
}

// ── Pace helpers ─────────────────────────────────────────

const WINDOW_DURATIONS_MS: Record<string, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export type PaceStatus = "under" | "on" | "over";

/**
 * Compare usage % against elapsed % of the window to determine pace.
 * Returns null if we can't compute (no reset time, no percent, or unknown window).
 */
export function computePace(w: UsageWindowSnapshot | null): { status: PaceStatus; elapsedPct: number } | null {
  if (!w || w.usedPercent == null || !w.resetAt) return null;
  const durationMs = WINDOW_DURATIONS_MS[w.window];
  if (!durationMs) return null;

  const millis = Number(w.resetAt);
  const resetTime = Number.isFinite(millis) ? millis * 1000 : new Date(w.resetAt).getTime();
  if (Number.isNaN(resetTime)) return null;

  const now = Date.now();
  const windowStart = resetTime - durationMs;
  const elapsed = now - windowStart;
  const elapsedPct = Math.min(Math.max((elapsed / durationMs) * 100, 0), 100);

  const used = w.usedPercent;
  // Give a 10% buffer around the elapsed line for "on pace"
  if (used <= elapsedPct * 0.8) return { status: "under", elapsedPct };
  if (used >= elapsedPct * 1.2) return { status: "over", elapsedPct };
  return { status: "on", elapsedPct };
}

export function paceLabel(status: PaceStatus): string {
  switch (status) {
    case "under": return "under pace";
    case "on": return "on pace";
    case "over": return "over pace";
  }
}
