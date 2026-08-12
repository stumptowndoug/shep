import { useMemo, useState, useCallback } from "react";
import { useUsageStore } from "../../stores/useUsageStore";
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
  getProviderLabel,
  paceLabel,
  shouldShowUsageWindow,
  syntheticMonthlyBudgetWindow,
  type PaceStatus,
} from "../usage/usageHelpers";
import type { UsageProvider, UsageSettings, ProviderUsageSnapshot } from "../../lib/types";

const PACE_LABEL_COLORS: Record<PaceStatus, string> = {
  under: "var(--status-added)",
  on: "var(--text-muted)",
  over: "var(--status-crashed)",
};

interface SidebarUtilizationItem {
  id: string;
  provider: UsageProvider;
  label: string;
  pct: number | null;
  sublabel: string;
  pace: { status: PaceStatus; elapsedPct: number } | null;
  meta?: string;
}

interface TooltipState {
  item: SidebarUtilizationItem;
  rect: DOMRect;
}

function buildUtilizationItems(
  snapshots: Record<string, ProviderUsageSnapshot>,
  settings: UsageSettings,
): SidebarUtilizationItem[] {
  const items: SidebarUtilizationItem[] = [];

  ALL_USAGE_PROVIDERS.forEach((provider) => {
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show || config.budgetMode !== "custom" || config.monthlyBudget == null || config.monthlyBudget <= 0) return;

    const budgetWindow = syntheticMonthlyBudgetWindow(
      provider,
      snap?.localDetails?.costMonth ?? 0,
      config.monthlyBudget,
    );
    if (!budgetWindow || budgetWindow.usedPercent == null || budgetWindow.limit == null || budgetWindow.used == null) return;

    items.push({
      id: `budget-${provider}`,
      provider,
      label: budgetWindow.label,
      pct: budgetWindow.usedPercent,
      sublabel: `${formatCost(budgetWindow.used)} spent of ${formatCost(budgetWindow.limit)}`,
      pace: computePace(budgetWindow),
    });
  });

  ALL_USAGE_PROVIDERS.forEach((provider) => {
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show || config.budgetMode !== "subscription") return;

    const windows = (snap?.summaryWindows ?? [])
      .filter((w) =>
        w.usedPercent != null
        && w.sourceType === "provider"
        && shouldShowUsageWindow(provider, w.window, settings.showClaudeFiveHourLimit)
      );

    if (windows.length === 0) {
      items.push({
        id: `pending-${provider}`,
        provider,
        label: "",
        pct: null,
        sublabel: snap?.error ?? "Loading usage…",
        pace: null,
      });
      return;
    }

    windows.forEach((w) => {
      const pace = computePace(w);
      items.push({
        id: w.windowId,
        provider,
        label: w.label,
        pct: w.usedPercent!,
        sublabel: w.remainingPercent != null ? `${formatPercent(w.remainingPercent)} remaining` : "",
        pace,
        meta: w.resetAt ? `resets in ${formatReset(w.resetAt)}` : undefined,
      });
    });
  });

  const paceRank: Record<PaceStatus, number> = { over: 0, on: 1, under: 2 };
  return items.sort((a, b) => {
    const aRank = a.pace ? paceRank[a.pace.status] : 3;
    const bRank = b.pace ? paceRank[b.pace.status] : 3;
    return aRank - bRank || (b.pct ?? -1) - (a.pct ?? -1);
  });
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
        {item.label && <span className="sidebar-usage__tooltip-window">{item.label}</span>}
      </div>

      <div className="sidebar-usage__tooltip-rows">
        <div className="sidebar-usage__tooltip-row sidebar-usage__tooltip-row--total">
          <span>Used</span>
          <span>{formatPercent(item.pct)}</span>
        </div>
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
  const usageSettings = useUsageSettingsStore((s) => s.settings);
  const { toggleUsagePanel } = useUIStore.getState();

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const items = useMemo(
    () => buildUtilizationItems(snapshots, usageSettings),
    [snapshots, usageSettings],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  if (items.length === 0) return null;

  return (
    <div className="sidebar-usage">
      <div className="sidebar-usage__header">
        <div className="section-label !p-0">Utilization</div>
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
                    style={{ width: `${Math.min(item.pct ?? 0, 100)}%`, background: TONE_COLORS[tone] }}
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
