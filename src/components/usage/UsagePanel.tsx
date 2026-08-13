import { useCallback, useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getUsageOverview, refreshUsageData } from "../../lib/tauri";
import type {
  UsageCost,
  UsageBreakdownItem,
  UsageOverview,
  UsageProvider,
  UsageTrendBucket,
  UsageSettings,
  ProviderUsageSnapshot,
} from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useUsageStore, type TimeWindow } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import {
  ALL_USAGE_PROVIDERS,
  TONE_COLORS,
  TONE_TRACK,
  barTone,
  formatCost,
  formatPercent,
  formatReset,
  formatTokenCount,
  getProviderLabel,
  computePace,
  paceLabel,
  shouldShowUsageWindow,
  type PaceStatus,
} from "./usageHelpers";

const TIME_WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: "24h", label: "24 hour" },
  { key: "7d", label: "7 day" },
  { key: "30d", label: "30 day" },
  { key: "365d", label: "1 year" },
];

function presentCost(value: number | null): string {
  return value != null ? formatCost(value) : "—";
}

function costKindLabel(costDetail: UsageCost): string {
  switch (costDetail.kind) {
    case "recorded":
      return "Recorded";
    case "estimated":
      return "List-price";
    case "included":
      return "Included";
    case "free":
      return "Free";
    case "mixed":
      return "Mixed";
    case "unknown":
      return "Unknown";
  }
}

function costKindMeta(costDetail: UsageCost): string {
  const label = costKindLabel(costDetail);
  return costDetail.confidence === "official" ? `${label} · official` : label;
}

function formatHourLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric" });
}

interface TooltipData {
  label: string;
  tokens: string;
  cost: string | null;
}

function useChartTooltip() {
  const [tip, setTip] = useState<TooltipData | null>(null);

  const show = useCallback((_e: React.MouseEvent, label: string, tokens: number, cost: number | null) => {
    setTip({
      label,
      tokens: formatTokenCount(tokens),
      cost: cost != null ? formatCost(cost) : null,
    });
  }, []);

  const hide = useCallback(() => setTip(null), []);

  return { tip, show, hide };
}

function ChartTooltip({ tip }: { tip: TooltipData }) {
  return (
    <div className="usage-tooltip">
      <span className="usage-tooltip__label">{tip.label}</span>
      <span className="usage-tooltip__sep">/</span>
      <span className="usage-tooltip__value">{tip.tokens}</span>
      {tip.cost && (
        <>
          <span className="usage-tooltip__sep">/</span>
          <span className="usage-tooltip__cost">{tip.cost}</span>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <div className="usage-stat">
      <span className="usage-stat__label">{label}</span>
      <strong className="usage-stat__value">{value}</strong>
      {meta && <span className="usage-stat__meta">{meta}</span>}
    </div>
  );
}

function buildLocalDates(window: TimeWindow, count: number): Date[] {
  const now = new Date();

  if (window === "24h") {
    const base = new Date(now);
    base.setMinutes(0, 0, 0);
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(base);
      date.setHours(base.getHours() - (count - 1 - index));
      return date;
    });
  }

  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() - (count - 1 - index));
    return date;
  });
}

function buildHeatmapMonthLabels(dates: Date[]) {
  const leadingEmpty = dates[0]?.getDay() ?? 0;
  const weekCount = Math.ceil((leadingEmpty + dates.length) / 7);
  const seen = new Set<string>();

  return Array.from({ length: weekCount }, (_, weekIndex) => {
    const weekStart = weekIndex * 7 - leadingEmpty;
    const weekDates = dates.filter((_, dateIndex) => dateIndex >= weekStart && dateIndex < weekStart + 7);
    // Only label the week containing the 1st of the month
    const firstOfMonth = weekDates.find((date) => date.getDate() === 1);
    const labelDate = firstOfMonth ?? (weekIndex === 0 ? weekDates[0] : undefined);
    if (!labelDate) return "";
    const key = `${labelDate.getFullYear()}-${labelDate.getMonth()}`;
    if (seen.has(key)) return "";
    seen.add(key);
    return labelDate.toLocaleDateString([], { month: "short" });
  });
}

function ActivityBarChart({
  trend,
  window,
}: {
  trend: UsageTrendBucket[];
  window: TimeWindow;
}) {
  const maxTokens = Math.max(...trend.map((bucket) => bucket.tokens), 1);
  const bucketCount = trend.length;
  const dates = buildLocalDates(window, bucketCount);
  const { tip, show, hide } = useChartTooltip();

  return (
    <div className="usage-chart">
      <div className="usage-chart__bars" aria-hidden="true">
        {trend.map((bucket, index) => {
          const date = dates[index];
          const intensity = bucket.tokens === 0 ? 0 : Math.max(bucket.tokens / maxTokens, 0.12);
          const height = bucket.tokens === 0 ? 8 : Math.max((bucket.tokens / maxTokens) * 100, 10);
          const dateLabel = window === "24h"
            ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })
            : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
          return (
            <div key={`${bucket.start}-${bucket.end}`} className="usage-chart__bar-wrap">
              <div className="usage-chart__bar-area">
                <div
                  className="usage-chart__bar"
                  style={{
                    height: `${height}%`,
                    background: bucket.tokens === 0
                      ? "color-mix(in srgb, var(--text-primary), transparent 96%)"
                      : `linear-gradient(180deg,
                          color-mix(in srgb, var(--text-primary), transparent ${92 - intensity * 14}%),
                          color-mix(in srgb, var(--status-running), transparent ${88 - intensity * 48}%)
                        )`,
                  }}
                  onMouseEnter={(e) => show(e, dateLabel, bucket.tokens, bucket.cost)}
                  onMouseMove={(e) => show(e, dateLabel, bucket.tokens, bucket.cost)}
                  onMouseLeave={hide}
                />
              </div>
              <span className="usage-chart__label">
                {window === "24h"
                  ? formatHourLabel(date)
                  : date.toLocaleDateString([], { weekday: "short", day: "numeric" })}
              </span>
            </div>
          );
        })}
      </div>
      <div className="usage-chart__footer">
        <div className="usage-chart__footer-left">
          {tip && <ChartTooltip tip={tip} />}
        </div>
        <div className="usage-chart__legend">
          <span>Less</span>
          <div className="usage-chart__legend-scale">
            <span className="usage-chart__legend-bar" />
            <span className="usage-chart__legend-bar usage-chart__legend-bar--mid" />
            <span className="usage-chart__legend-bar usage-chart__legend-bar--high" />
          </div>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function ActivityHeatmap({
  trend,
  window,
}: {
  trend: UsageTrendBucket[];
  window: TimeWindow;
}) {
  const dates = buildLocalDates(window, trend.length);
  const maxTokens = Math.max(...trend.map((bucket) => bucket.tokens), 1);
  const leadingEmpty = dates[0]?.getDay() ?? 0;
  const monthLabels = buildHeatmapMonthLabels(dates);
  const isYear = window === "365d";
  const cellSize = isYear ? 13 : 14;
  const cellGap = isYear ? 3 : 4;
  const { tip, show, hide } = useChartTooltip();

  return (
    <div className={`usage-heatmap ${isYear ? "usage-heatmap--year" : ""}`}>
      <div className="usage-heatmap__scroll">
        <div
          className="usage-heatmap__month-row"
          style={{
            gridTemplateColumns: `repeat(${monthLabels.length}, ${cellSize}px)`,
            gap: `${cellGap}px`,
          }}
          aria-hidden="true"
        >
          {monthLabels.map((label, index) => (
            <span key={`month-${index}`} className="usage-heatmap__month-label">
              {label}
            </span>
          ))}
        </div>

        <div className="usage-heatmap__frame">
          <div
            className="usage-heatmap__weekday-col"
            style={{ gridTemplateRows: `repeat(7, ${cellSize}px)`, gap: `${cellGap}px` }}
            aria-hidden="true"
          >
            <span />
            <span>Mon</span>
            <span />
            <span>Wed</span>
            <span />
            <span>Fri</span>
            <span />
          </div>
          <div
            className="usage-heatmap__grid"
            style={{
              gridTemplateRows: `repeat(7, ${cellSize}px)`,
              gridAutoColumns: `${cellSize}px`,
              gridAutoFlow: "column",
              gap: `${cellGap}px`,
            }}
            aria-hidden="true"
          >
            {Array.from({ length: leadingEmpty }).map((_, index) => (
              <span key={`empty-${index}`} className="usage-heatmap__empty" />
            ))}
            {trend.map((bucket, index) => {
              const intensity = bucket.tokens === 0 ? 0 : Math.max(bucket.tokens / maxTokens, 0.12);
              const date = dates[index];
              const dateLabel = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
              return (
                <span
                  key={`${bucket.start}-${bucket.end}`}
                  className="usage-heatmap__cell"
                  style={{
                    width: cellSize,
                    height: cellSize,
                    background: bucket.tokens === 0
                      ? "color-mix(in srgb, var(--text-primary), transparent 96%)"
                      : `linear-gradient(180deg,
                          color-mix(in srgb, var(--text-primary), transparent ${92 - intensity * 14}%),
                          color-mix(in srgb, var(--status-running), transparent ${88 - intensity * 48}%)
                        )`,
                  }}
                  onMouseEnter={(e) => show(e, dateLabel, bucket.tokens, bucket.cost)}
                  onMouseMove={(e) => show(e, dateLabel, bucket.tokens, bucket.cost)}
                  onMouseLeave={hide}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="usage-chart__footer">
        <div className="usage-chart__footer-left">
          {tip && <ChartTooltip tip={tip} />}
        </div>
        <div className="usage-chart__legend">
          <span>Less</span>
          <div className="usage-chart__legend-scale">
            <span className="usage-chart__legend-bar" />
            <span className="usage-chart__legend-bar usage-chart__legend-bar--mid" />
            <span className="usage-chart__legend-bar usage-chart__legend-bar--high" />
          </div>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function Sparkline({
  values,
}: {
  values: number[];
}) {
  const width = 110;
  const height = 22;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - (value / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg className="usage-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}

function UsageListHeader({
  title = "Name",
  withSparklines = false,
}: {
  title?: string;
  withSparklines?: boolean;
}) {
  return (
    <div className="usage-list__row usage-list__row--header" aria-hidden="true">
      <div className="usage-list__heading">{title}</div>
      <div className="usage-list__values">
        <div className="usage-list__col-trend">
          {withSparklines && <span className="usage-list__heading">Trend</span>}
        </div>
        <span className="usage-list__heading usage-list__col-metric">Est. Cost</span>
        <span className="usage-list__heading usage-list__col-metric">Input</span>
        <span className="usage-list__heading usage-list__col-metric">Output</span>
        <span className="usage-list__heading usage-list__col-metric">Cache</span>
        <span className="usage-list__heading usage-list__col-total">Total</span>
      </div>
    </div>
  );
}

function TokenMetricColumns({
  cost,
  input,
  output,
  cacheRead,
  cacheWrite,
  total,
}: {
  cost: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}) {
  const cache = cacheRead + cacheWrite;
  return (
    <>
      <span className="usage-list__metric usage-list__col-metric">{presentCost(cost)}</span>
      <span className="usage-list__metric usage-list__col-metric">{formatTokenCount(input)}</span>
      <span className="usage-list__metric usage-list__col-metric">{formatTokenCount(output)}</span>
      <span className="usage-list__metric usage-list__col-metric">{formatTokenCount(cache)}</span>
      <strong className="usage-list__metric usage-list__metric--primary usage-list__col-total">{formatTokenCount(total)}</strong>
    </>
  );
}

function BreakdownList({
  title,
  emptyLabel,
  items,
  showSessions = false,
  withSparklines = false,
}: {
  title: string;
  emptyLabel: string;
  items: UsageBreakdownItem[];
  showSessions?: boolean;
  withSparklines?: boolean;
}) {
  const sortedItems = [...items].sort((a, b) => b.tokens - a.tokens);
  const headerTitle = title.endsWith(" Breakdown") ? title.replace(" Breakdown", "") : title;
  const singularTitle = headerTitle.endsWith("s") ? headerTitle.slice(0, -1) : headerTitle;

  return (
    <section className="usage-section">
      {sortedItems.length > 0 ? (
        <div className="usage-list">
          <UsageListHeader title={singularTitle} withSparklines={withSparklines} />
          {sortedItems.map((item) => (
            <div key={`${item.provider}-${item.label}`} className="usage-list__row">
              <div className="usage-list__info">
                <span className="usage-list__label">{item.label}</span>
                <span className="usage-list__meta">
                  {getProviderLabel(item.provider)}
                  {showSessions && item.sessions != null ? ` • ${item.sessions} sessions` : ""}
                  {` • ${costKindMeta(item.costDetail)}`}
                </span>
              </div>
              <div className="usage-list__values">
                <div className="usage-list__col-trend">
                  {withSparklines && <Sparkline values={item.trend} />}
                </div>
                <TokenMetricColumns
                  cost={item.cost}
                  input={item.tokensInput}
                  output={item.tokensOutput}
                  cacheRead={item.tokensCacheRead}
                  cacheWrite={item.tokensCacheWrite}
                  total={item.tokens}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="usage-empty">{emptyLabel}</div>
      )}
    </section>
  );
}

const PACE_LABEL_COLORS: Record<string, string> = {
  under: "var(--status-added)",
  on: "var(--text-muted)",
  over: "var(--status-crashed)",
};

function UtilizationSection({
  snapshots,
  settings,
}: {
  snapshots: Record<string, ProviderUsageSnapshot>;
  settings: UsageSettings;
}) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const elapsedMonthPct = Math.min(Math.max(((now.getTime() - monthStart.getTime()) / (nextMonth.getTime() - monthStart.getTime())) * 100, 0), 100);

  // 1. Collect and standardize all items
  const items: Array<{
    id: string;
    provider: UsageProvider;
    label: string;
    pct: number | null;
    sublabel: string;
    pace: { status: PaceStatus; elapsedPct: number } | null;
    meta?: string;
  }> = [];

  // Add Budgets
  ALL_USAGE_PROVIDERS.forEach((p) => {
    const config = settings[p];
    const snap = snapshots[p];
    if (!config.show || config.budgetMode !== "custom" || config.monthlyBudget == null || config.monthlyBudget <= 0) return;

    const budget = config.monthlyBudget;
    const currentMonthCost = snap?.localDetails?.costMonth ?? 0;
    const usedPct = (currentMonthCost / budget) * 100;
    const delta = usedPct - elapsedMonthPct;
    const paceStatus: PaceStatus = delta <= -10 ? "under" : delta >= 10 ? "over" : "on";

    items.push({
      id: `budget-${p}`,
      provider: p,
      label: "Monthly Budget",
      pct: usedPct,
      sublabel: `${presentCost(currentMonthCost)} spent of ${presentCost(budget)}`,
      pace: { status: paceStatus, elapsedPct: elapsedMonthPct },
    });
  });

  // Subscription limits are provider-defined and independent of the local
  // analytics window selected above.
  ALL_USAGE_PROVIDERS.forEach((provider) => {
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show || config.budgetMode !== "subscription") return;
    const windows = (snap?.summaryWindows ?? [])
      .filter((sw) =>
        sw.usedPercent != null
        && sw.sourceType === "provider"
        && shouldShowUsageWindow(provider, sw.window, settings.showClaudeFiveHourLimit)
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

  if (items.length === 0) return null;

  // 2. Sort by utilization percentage descending
  const sortedItems = [...items].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

  return (
    <div className="usage-limits">
      <div className="usage-section__header !mb-4">
        <h3 className="section-label !p-0">Utilization</h3>
      </div>
      {sortedItems.map((item) => {
        const tone = barTone(item.pace, item.pct);
        const logoSrc = assistantLogoSrc[item.provider];

        return (
          <div key={item.id} className="usage-limit">
            <div className="usage-limit__header">
              <span className="usage-limit__provider">
                {logoSrc && <img src={logoSrc} alt="" className={`usage-list__icon ${getAssistantLogoClass(item.provider) ?? ""}`} />}
                {getProviderLabel(item.provider)}{item.label ? ` · ${item.label}` : ""}
              </span>
              <span className="usage-limit__pct">{formatPercent(item.pct)}</span>
            </div>
            <div className="usage-limit__bar">
              <div className="usage-limit__bar-track" style={{ background: TONE_TRACK[tone] }} />
              <div
                className="usage-limit__bar-fill"
                style={{
                  width: `${Math.min(item.pct ?? 0, 100)}%`,
                  background: TONE_COLORS[tone],
                }}
              />
              {item.pace && (
                <div
                  className="usage-limit__bar-pace"
                  style={{ left: `${Math.min(item.pace.elapsedPct, 100)}%` }}
                />
              )}
            </div>
            <div className="usage-limit__meta">
              <span>{item.sublabel}</span>
              {item.pace && (
                <span style={{ color: PACE_LABEL_COLORS[item.pace.status] }}>{paceLabel(item.pace.status)}</span>
              )}
              {item.meta && <span>{item.meta}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
function OverviewPanel({ overview, snapshots }: { overview: UsageOverview; snapshots: Record<string, ProviderUsageSnapshot> }) {
  const usageSettings = useUsageSettingsStore((s) => s.settings);
  const chart = overview.window === "30d" || overview.window === "365d"
    ? <ActivityHeatmap trend={overview.trend} window={overview.window as TimeWindow} />
    : <ActivityBarChart trend={overview.trend} window={overview.window as TimeWindow} />;

  // Sort providers by tokens descending
  const sortedProviders = [...overview.providers].sort((a, b) => b.tokens - a.tokens);

  const totalInput = overview.providers.reduce((sum, p) => sum + p.tokensInput, 0);
  const totalOutput = overview.providers.reduce((sum, p) => sum + p.tokensOutput, 0);
  const totalCache = overview.providers.reduce((sum, p) => sum + p.tokensCacheRead + p.tokensCacheWrite, 0);

  return (
    <>
      <section className="usage-section">
        <div className="usage-section__header">
          <h3 className="section-label !p-0">Activity</h3>
        </div>
        <div className="usage-activity">
          <div className="usage-activity__summary">
            <div className="usage-stats">
              <Stat label="Est. Cost" value={presentCost(overview.totalCost)} meta={costKindMeta(overview.totalCostDetail)} />
              <Stat label="Input" value={formatTokenCount(totalInput)} />
              <Stat label="Output" value={formatTokenCount(totalOutput)} />
              <Stat label="Cache" value={formatTokenCount(totalCache)} />
              <Stat label="Total" value={formatTokenCount(overview.totalTokens)} />
            </div>
          </div>
          <div className="usage-activity__chart">
            {chart}
          </div>
        </div>
      </section>

      <section className="usage-section">
        <div className="usage-list">
          <UsageListHeader title="Provider" withSparklines />
          {sortedProviders.map((provider) => {
            const logoSrc = assistantLogoSrc[provider.provider];
            return (
              <div key={provider.provider} className="usage-list__row">
                <div className="usage-list__info">
                  <span className="usage-list__label usage-list__label--provider">
                    {logoSrc ? <img src={logoSrc} alt="" className={`usage-list__icon ${getAssistantLogoClass(provider.provider) ?? ""}`} /> : null}
                    {getProviderLabel(provider.provider)}
                  </span>
                  <span className="usage-list__meta">
                    {formatPercent(provider.sharePercent)} of total • {costKindMeta(provider.costDetail)}
                  </span>
                </div>
                <div className="usage-list__values">
                  <div className="usage-list__col-trend">
                    <Sparkline values={provider.trend} />
                  </div>
                  <TokenMetricColumns
                    cost={provider.cost}
                    input={provider.tokensInput}
                    output={provider.tokensOutput}
                    cacheRead={provider.tokensCacheRead}
                    cacheWrite={provider.tokensCacheWrite}
                    total={provider.tokens}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="usage-section">
        <UtilizationSection
          snapshots={snapshots}
          settings={usageSettings}
        />
      </section>

      <BreakdownList
        title="Model Breakdown"
        emptyLabel="No model activity yet for this window."
        items={overview.topModels}
        withSparklines
      />

      <BreakdownList
        title="Project Breakdown"
        emptyLabel="No project activity yet for this window."
        items={overview.topProjects}
        showSessions
        withSparklines
      />

      <section className="usage-section">
        <div className="usage-section__header">
          <h3 className="section-label !p-0">Methodology</h3>
        </div>
        <ul className="usage-methodology">
          <li>Usage totals and breakdowns on this screen are based on locally observed activity from this machine, except Cursor, which uses Cursor's billing aggregates for the selected window.</li>
          <li>Cursor does not expose per-project or per-session usage, so it will not appear in the project list or activity heatmap.</li>
          <li>Provider percentages shown in the sidebar summary come from provider-reported usage windows when available, so they are not always directly comparable to the local totals shown here.</li>
          <li>In practice, that means the sidebar percentage and this detail view can differ because they are measuring related but not identical sources.</li>
        </ul>
      </section>
    </>
  );
}

export default function UsagePanel() {
  const fetchSnapshots = useUsageStore((s) => s.fetchSnapshots);
  const snapshots = useUsageStore((s) => s.snapshots);
  const loading = useUsageStore((s) => s.loading);
  const window = useUsageStore((s) => s.window);
  const setWindow = useUsageStore((s) => s.setWindow);

  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      setOverview(await getUsageOverview(window));
    } finally {
      setOverviewLoading(false);
    }
  }, [window]);

  // Fetch overview on initial mount
  useEffect(() => {
    void fetchOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh when background ingest completes
  useEffect(() => {
    const unlisten = listen("usage-ingest-complete", () => {
      void fetchOverview();
    });
    return () => { unlisten.then((f) => f()); };
  }, [fetchOverview]);

  const handleRefresh = useCallback(async () => {
    await refreshUsageData();
    void fetchSnapshots();
    void fetchOverview();
  }, [fetchOverview, fetchSnapshots]);

  const isBusy = loading || overviewLoading;

  return (
    <div className="absolute inset-0 overflow-y-auto pt-3 pb-6">
      <div className="usage-window-tabs-row">
        <div className="usage-window-tabs">
          {TIME_WINDOWS.map((timeWindow) => (
            <button
              key={timeWindow.key}
              type="button"
              className={`usage-window-tab ${window === timeWindow.key ? "usage-window-tab--active" : ""}`}
              onClick={() => {
                setWindow(timeWindow.key);
                // fetchOverview depends on window via its useCallback dep —
                // but the store hasn't flushed yet, so build a fresh fetcher inline.
                setOverviewLoading(true);
                getUsageOverview(timeWindow.key).then(setOverview).finally(() => setOverviewLoading(false));
              }}
            >
              {timeWindow.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={handleRefresh}
          aria-label="Refresh usage"
        >
          <RefreshCcw size={14} className={isBusy ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="usage-panel">
        {overview ? (
          <OverviewPanel overview={overview} snapshots={snapshots} />
        ) : (
          <div className="usage-empty">Loading usage overview…</div>
        )}
      </div>
    </div>
  );
}
