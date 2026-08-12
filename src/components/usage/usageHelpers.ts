import type { ProviderUsageSnapshot, UsageProvider, UsageWindowSnapshot } from "../../lib/types";

const WINDOW_PRIORITY = ["5h", "7d", "billing", "30d"];
export const ALL_USAGE_PROVIDERS: UsageProvider[] = ["claude", "codex", "cursor", "antigravity", "gemini", "opencode", "pi", "grok"];
export const TONE_COLORS: Record<string, string> = {
  low: "color-mix(in srgb, var(--status-added) var(--color-opacity-utilization), transparent)",
  medium: "color-mix(in srgb, var(--status-attention) var(--color-opacity-utilization), transparent)",
  high: "color-mix(in srgb, var(--status-crashed) var(--color-opacity-utilization), var(--status-attention))",
  critical: "color-mix(in srgb, var(--status-crashed) var(--color-opacity-utilization), transparent)",
  local: "color-mix(in srgb, var(--status-running) var(--color-opacity-utilization), transparent)",
};

export const TONE_TRACK: Record<string, string> = {
  low: "color-mix(in srgb, var(--status-added) 10%, transparent)",
  medium: "color-mix(in srgb, var(--status-attention) 10%, transparent)",
  high: "color-mix(in srgb, var(--status-crashed) 10%, transparent)",
  critical: "color-mix(in srgb, var(--status-crashed) 10%, transparent)",
  local: "color-mix(in srgb, var(--status-running) 10%, transparent)",
};

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
    case "cursor":
      return "Cursor";
    case "gemini":
      return "Gemini";
    case "antigravity":
      return "Antigravity";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    case "grok":
      return "Grok";
  }
}

export function formatPercent(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value)}%`;
}

export function formatTokenCount(value: number | null): string {
  if (value == null) return "n/a";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 100_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${value}`;
}

export function formatCost(value: number | null): string {
  if (value == null) return "";
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`;
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

export function barTone(pace: ReturnType<typeof computePace>, pct: number | null | undefined): string {
  if (pct == null) return "local";
  if (pct >= 90) return "critical";
  if (pace?.status === "over") return pct >= 50 ? "high" : "medium";
  if (pct >= 75) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

function currentMonthRange(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

function currentFiveHourBlock(now: Date) {
  const start = new Date(now);
  const hour = start.getHours();
  start.setHours(hour - (hour % 5), 0, 0, 0);
  const end = new Date(start);
  end.setHours(start.getHours() + 5);
  return { start, end };
}

function currentSevenDayBlock(now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

export function syntheticBudgetWindow(
  provider: UsageProvider,
  window: "5h" | "7d",
  cost: number | null,
  monthlyBudget: number | null,
): UsageWindowSnapshot | null {
  if (cost == null || monthlyBudget == null || monthlyBudget <= 0) {
    return null;
  }

  const now = new Date();
  const month = currentMonthRange(now);
  const budgetRange = window === "5h" ? currentFiveHourBlock(now) : currentSevenDayBlock(now);
  const monthDurationMs = month.end.getTime() - month.start.getTime();
  const rangeDurationMs = window === "5h"
    ? 5 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;

  if (monthDurationMs <= 0 || rangeDurationMs <= 0) return null;

  const windowBudget = monthlyBudget * (rangeDurationMs / monthDurationMs);
  if (windowBudget <= 0) return null;

  return {
    provider,
    windowId: `${provider}-budget-${window}`,
    window,
    label: window,
    scope: "reporting",
    limit: windowBudget,
    used: cost,
    sourceType: "local",
    confidence: "estimated",
    costKind: "estimated",
    usedPercent: (cost / windowBudget) * 100,
    remainingPercent: Math.max(100 - (cost / windowBudget) * 100, 0),
    resetAt: new Date(budgetRange.end).toISOString(),
    tokenTotal: null,
    paceStatus: null,
  };
}
