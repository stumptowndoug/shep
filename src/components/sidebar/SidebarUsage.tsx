import { useMemo, useState, useCallback } from "react";
import { useUsageStore, type TimeWindow } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUIStore } from "../../stores/useUIStore";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import {
  ALL_USAGE_PROVIDERS,
  TONE_COLORS,
  TONE_TRACK,
  barTone,
  computePace,
  formatCost,
  formatPercent,
  formatReset,
  formatTokenCount,
  getProviderLabel,
  paceLabel,
  syntheticBudgetWindow,
  type PaceStatus,
} from "../usage/usageHelpers";
import type { UsageProvider, UsageSettings, ProviderUsageSnapshot } from "../../lib/types";
import type { UsageWindowSnapshot } from "../../lib/types";

type SidebarWindow = Extract<TimeWindow, "5h" | "7d">;

const WINDOWS: { key: SidebarWindow; label: string }[] = [
  { key: "7d", label: "7d" },
  { key: "5h", label: "5h" },
];

const PACE_LABEL_COLORS: Record<PaceStatus, string> = {
  under: "var(--status-added)",
  on: "var(--text-muted)",
  over: "var(--status-crashed)",
};

interface SidebarUtilizationItem {
  id: string;
  provider: UsageProvider;
  label: string;
  pct: number;
  tokens: number | null;
  sublabel: string;
  pace: { status: PaceStatus; elapsedPct: number } | null;
  meta?: string;
}

interface TooltipState {
  item: SidebarUtilizationItem;
  rect: DOMRect;
}

function sidebarProviderWindows(provider: UsageProvider, snap: ProviderUsageSnapshot, window: SidebarWindow): UsageWindowSnapshot[] {
  const windows = snap.summaryWindows
    .filter((sw) => sw.usedPercent != null && sw.sourceType === "provider")
    .filter((sw) => {
      if (window === "5h") {
        return provider === "claude" && sw.window === "5h";
      }
      return sw.window === window || sw.window.startsWith("24h_") || sw.window === "billing";
    });

  if (provider === "antigravity") {
    const mostUsed = [...windows].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    return mostUsed ? [mostUsed] : windows;
  }

  if (provider !== "gemini") return windows;

  const pro = windows.find((sw) => sw.window === "24h_pro");
  return pro ? [pro] : windows;
}

function windowTokenTotal(snap: ProviderUsageSnapshot, window: SidebarWindow): number {
  if (!snap.localDetails) return 0;
  return window === "5h" ? snap.localDetails.tokens5h : snap.localDetails.tokens7d;
}

function windowCostTotal(snap: ProviderUsageSnapshot, window: SidebarWindow): number | null {
  if (!snap.localDetails) return null;
  return window === "5h" ? snap.localDetails.cost5h : snap.localDetails.cost7d;
}

function buildUtilizationItems(
  snapshots: Record<string, ProviderUsageSnapshot>,
  settings: UsageSettings,
  window: SidebarWindow,
): SidebarUtilizationItem[] {
  const items: SidebarUtilizationItem[] = [];

  ALL_USAGE_PROVIDERS.forEach((provider) => {
    if (window === "5h" && provider !== "claude") return;
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show || config.budgetMode !== "custom" || config.monthlyBudget == null || config.monthlyBudget <= 0 || !snap?.localDetails) return;

    const budget = config.monthlyBudget;
    const periodCost = windowCostTotal(snap, window);
    const budgetWindow = syntheticBudgetWindow(provider, window, periodCost, budget);
    if (!budgetWindow || budgetWindow.usedPercent == null || budgetWindow.limit == null || budgetWindow.used == null) return;

    const pace = computePace(budgetWindow);
    const tokens = windowTokenTotal(snap, window);

    items.push({
      id: `budget-${provider}`,
      provider,
      label: `${window} Budget`,
      pct: budgetWindow.usedPercent,
      tokens,
      sublabel: `${formatCost(budgetWindow.used)} spent of ${formatCost(budgetWindow.limit)}`,
      pace,
    });
  });

  ALL_USAGE_PROVIDERS.forEach((provider) => {
    if (window === "5h" && provider !== "claude") return;
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show || !snap) return;
    const tokens = provider === "antigravity" ? null : windowTokenTotal(snap, window);

    sidebarProviderWindows(provider, snap, window)
      .forEach((w) => {
        const pace = computePace(w);
        items.push({
          id: w.windowId,
          provider,
          label: w.window.startsWith("24h_") || w.window === "billing" ? w.label : `${w.label} limit`,
          pct: w.usedPercent!,
          tokens,
          sublabel: w.remainingPercent != null ? `${formatPercent(w.remainingPercent)} remaining` : "",
          pace,
          meta: w.resetAt ? `resets in ${formatReset(w.resetAt)}` : undefined,
        });
      });
  });

  // Show providers with show=true even if $0/no activity
  const seenProviders = new Set(items.map((i) => i.provider));
  ALL_USAGE_PROVIDERS.forEach((provider) => {
    if (window === "5h" && provider !== "claude") return;
    const config = settings[provider];
    if (!config.show || seenProviders.has(provider)) return;
    // Cursor has no local cost feed, so a missing login must not look like $0 usage.
    if (provider === "cursor" && config.budgetMode === "subscription") return;
    const snap = snapshots[provider];
    const cost = snap?.localDetails ? ((window === "5h" ? snap.localDetails.cost5h : snap.localDetails.cost7d) ?? 0) : 0;
    const tokens = snap?.localDetails ? (window === "5h" ? snap.localDetails.tokens5h : snap.localDetails.tokens7d) : 0;

    if (config.budgetMode === "custom" && config.monthlyBudget != null && config.monthlyBudget > 0) {
      items.push({
        id: `budget-${provider}`,
        provider,
        label: `${window} Budget`,
        pct: 0,
        tokens,
        sublabel: `${formatCost(cost)} spent of ${formatCost(config.monthlyBudget)}`,
        pace: null,
      });
    } else {
      items.push({
        id: `cost-${provider}`,
        provider,
        label: `${window} Cost`,
        pct: 0,
        tokens,
        sublabel: formatCost(cost),
        pace: null,
      });
    }
  });

  return items.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.pct - a.pct);
}

function UsageTooltip({ tip }: { tip: TooltipState }) {
  const { item } = tip;
  const top = tip.rect.top + tip.rect.height / 2;
  const left = tip.rect.right + 10;

  return (
    <div
      className="sidebar-usage__tooltip"
      style={{ top, left, transform: "translateY(-50%)" }}
    >
      <div className="sidebar-usage__tooltip-header">
        {assistantLogoSrc[item.provider] && (
          <img
            src={assistantLogoSrc[item.provider]}
            alt=""
            className={`sidebar-usage__icon ${getAssistantLogoClass(item.provider) ?? ""}`}
            style={{ opacity: 1 }}
          />
        )}
        <span>{getProviderLabel(item.provider)}</span>
        <span className="sidebar-usage__tooltip-window">{item.label}</span>
      </div>

      <div className="sidebar-usage__tooltip-rows">
        <div className="sidebar-usage__tooltip-row sidebar-usage__tooltip-row--total">
          <span>Used</span>
          <span>{formatPercent(item.pct)}</span>
        </div>
        {item.tokens != null && (
          <div className="sidebar-usage__tooltip-row">
            <span>Tokens</span>
            <span>{formatTokenCount(item.tokens)}</span>
          </div>
        )}
        {item.sublabel && (
          <div className="sidebar-usage__tooltip-row">
            <span>Detail</span>
            <span>{item.sublabel}</span>
          </div>
        )}
        {item.pace && (
          <div className="sidebar-usage__tooltip-row">
            <span>Pace</span>
            <span style={{ color: PACE_LABEL_COLORS[item.pace.status] }}>{paceLabel(item.pace.status)}</span>
          </div>
        )}
        {item.meta && (
          <div className="sidebar-usage__tooltip-row">
            <span>Reset</span>
            <span>{item.meta.replace(/^resets in /, "")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SidebarUsage() {
  const snapshots = useUsageStore((s) => s.snapshots);
  const window = useUsageStore((s) => s.sidebarWindow);
  const usageSettings = useUsageSettingsStore((s) => s.settings);
  const { setSidebarWindow } = useUsageStore.getState();
  const { toggleUsagePanel } = useUIStore.getState();

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const items = useMemo(
    () => buildUtilizationItems(snapshots, usageSettings, window),
    [snapshots, usageSettings, window],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  if (items.length === 0) return null;

  return (
    <div className="sidebar-usage">
      <div className="sidebar-usage__header">
        <div className="section-label !p-0">Utilization</div>
        <div className="sidebar-usage__window-toggle">
          {WINDOWS.map((tw) => (
            <button
              key={tw.key}
              type="button"
              className={`sidebar-usage__window-btn ${window === tw.key ? "sidebar-usage__window-btn--active" : ""}`}
              onClick={() => setSidebarWindow(tw.key)}
            >
              {tw.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-usage__providers">
        {items.map((item) => {
          const tone = barTone(item.pace, item.pct);
          const logoSrc = assistantLogoSrc[item.provider];

          return (
            <button
              key={item.id}
              type="button"
              className="sidebar-usage__row"
              onClick={toggleUsagePanel}
              onMouseEnter={(e) => setTooltip({ item, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={handleMouseLeave}
            >
              {logoSrc ? (
                <img src={logoSrc} alt={item.provider} className={`sidebar-usage__icon ${getAssistantLogoClass(item.provider) ?? ""}`} />
              ) : (
                <span className="sidebar-usage__name">{item.provider}</span>
              )}

              <div className="sidebar-usage__bar-wrap">
                <div className="sidebar-usage__bar">
                  <div className="sidebar-usage__bar-track" style={{ background: TONE_TRACK[tone] }} />
                  <div
                    className="sidebar-usage__bar-fill"
                    style={{ width: `${Math.min(item.pct, 100)}%`, background: TONE_COLORS[tone] }}
                  />
                  {item.pace && (
                    <div
                      className="sidebar-usage__bar-pace"
                      style={{ left: `${Math.min(item.pace.elapsedPct, 100)}%` }}
                      title={`${Math.round(item.pace.elapsedPct)}% of window elapsed`}
                    />
                  )}
                </div>
              </div>

              <span className="sidebar-usage__value">
                {formatPercent(item.pct)}
              </span>
            </button>
          );
        })}
      </div>

      {tooltip && <UsageTooltip tip={tooltip} />}
    </div>
  );
}
