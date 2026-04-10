import { useCallback, useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getUsageOverview, refreshUsageData } from "../../lib/tauri";
import type {
  UsageBreakdownItem,
  UsageOverview,
  UsageTrendBucket,
} from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useUsageStore, type TimeWindow } from "../../stores/useUsageStore";
import { formatCost, formatPercent, formatReset, formatTokenCount, getProviderLabel, computePace, paceLabel } from "./usageHelpers";
import type { UsageProvider, ProviderUsageSnapshot, UsageWindowSnapshot } from "../../lib/types";

const TIME_WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: "5h", label: "5 hour" },
  { key: "7d", label: "7 day" },
  { key: "30d", label: "30 day" },
  { key: "365d", label: "1 year" },
];

function presentCost(value: number | null): string {
  return value != null ? formatCost(value) : "—";
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

  if (window === "5h") {
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
          const dateLabel = window === "5h"
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
                {window === "5h"
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
  const width = 96;
  const height = 26;
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
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
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
  return (
    <section className="usage-section">
      <div className="usage-section__header">
        <h3 className="section-label !p-0">{title}</h3>
      </div>
      {items.length > 0 ? (
        <div className="usage-list">
          {items.map((item) => (
            <div key={`${item.provider}-${item.label}`} className="usage-list__row">
              <div className="usage-list__info">
                <span className="usage-list__label">{item.label}</span>
                <span className="usage-list__meta">
                  {getProviderLabel(item.provider)}
                  {showSessions && item.sessions != null ? ` • ${item.sessions} sessions` : ""}
                </span>
              </div>
              <div className="usage-list__values">
                {withSparklines && (
                  <div className="usage-list__sparkline-wrap">
                    <Sparkline values={item.trend} />
                  </div>
                )}
                <span className="usage-list__metric">{presentCost(item.cost)}</span>
                <strong className="usage-list__metric usage-list__metric--primary">{formatTokenCount(item.tokens)}</strong>
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

const TONE_COLORS: Record<string, string> = {
  low: "rgba(52, 211, 153, 0.75)",
  medium: "rgba(245, 158, 11, 0.75)",
  high: "rgba(251, 146, 60, 0.85)",
  critical: "rgba(248, 113, 113, 0.9)",
  local: "rgba(96, 165, 250, 0.5)",
};

const TONE_TRACK: Record<string, string> = {
  low: "rgba(52, 211, 153, 0.1)",
  medium: "rgba(245, 158, 11, 0.1)",
  high: "rgba(251, 146, 60, 0.12)",
  critical: "rgba(248, 113, 113, 0.14)",
  local: "rgba(96, 165, 250, 0.08)",
};

function barTone(pace: ReturnType<typeof computePace>, pct: number | null | undefined): string {
  if (pct == null) return "local";
  if (pct >= 90) return "critical";
  if (pace?.status === "over") return pct >= 50 ? "high" : "medium";
  if (pct >= 75) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

const PACE_LABEL_COLORS: Record<string, string> = {
  under: "rgba(52, 211, 153, 0.8)",
  on: "var(--text-muted)",
  over: "rgba(248, 113, 113, 0.8)",
};

function ProviderLimits({
  snapshots,
  window,
}: {
  snapshots: Record<string, ProviderUsageSnapshot>;
  window: TimeWindow;
}) {
  if (window !== "5h" && window !== "7d") return null;

  const providers = (["claude", "codex", "gemini", "opencode"] as UsageProvider[]).filter((p) => {
    const snap = snapshots[p];
    if (!snap) return false;
    const w = snap.summaryWindows.find((sw) => sw.window === window);
    return w?.usedPercent != null;
  });

  if (providers.length === 0) return null;

  return (
    <>
    <hr className="settings-divider" />
    <section className="usage-section">
      <div className="usage-section__header">
        <h3 className="section-label !p-0">Rate Limits</h3>
        <span className="usage-section__hint">{window} window</span>
      </div>
      <div className="usage-limits">
        {providers.map((provider) => {
          const snap = snapshots[provider]!;
          const w = snap.summaryWindows.find((sw) => sw.window === window) as UsageWindowSnapshot;
          const pct = w.usedPercent ?? 0;
          const remaining = w.remainingPercent;
          const pace = computePace(w);
          const tone = barTone(pace, w.usedPercent);
          const logoSrc = assistantLogoSrc[provider];

          return (
            <div key={provider} className="usage-limit">
              <div className="usage-limit__header">
                <span className="usage-limit__provider">
                  {logoSrc ? <img src={logoSrc} alt="" className={`usage-list__icon ${getAssistantLogoClass(provider) ?? ""}`} /> : null}
                  {getProviderLabel(provider)}
                </span>
                <span className="usage-limit__pct">{formatPercent(pct)} used</span>
              </div>
              <div className="usage-limit__bar">
                <div
                  className="usage-limit__bar-track"
                  style={{ background: TONE_TRACK[tone] }}
                />
                <div
                  className="usage-limit__bar-fill"
                  style={{
                    width: `${Math.min(pct, 100)}%`,
                    background: TONE_COLORS[tone],
                  }}
                />
                {pace && pct > 0 && (
                  <div
                    className="usage-limit__bar-pace"
                    style={{ left: `${Math.min(pace.elapsedPct, 100)}%` }}
                  />
                )}
              </div>
              <div className="usage-limit__meta">
                {remaining != null && (
                  <span>{formatPercent(remaining)} remaining</span>
                )}
                {pace && (
                  <span style={{ color: PACE_LABEL_COLORS[pace.status] }}>
                    {paceLabel(pace.status)}
                  </span>
                )}
                {w.resetAt && (
                  <span>resets in {formatReset(w.resetAt)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
    </>
  );
}

function OverviewPanel({ overview, snapshots }: { overview: UsageOverview; snapshots: Record<string, ProviderUsageSnapshot> }) {
  const chart = overview.window === "30d" || overview.window === "365d"
    ? <ActivityHeatmap trend={overview.trend} window={overview.window as TimeWindow} />
    : <ActivityBarChart trend={overview.trend} window={overview.window as TimeWindow} />;

  return (
    <>
      <section className="usage-section">
        <div className="usage-section__header">
          <h3 className="section-label !p-0">Activity</h3>
        </div>
        <div className="usage-activity">
          <div className="usage-activity__summary">
            <div className="usage-stats">
              <Stat label="Total Tokens" value={formatTokenCount(overview.totalTokens)} />
              <Stat label="Estimated Cost" value={presentCost(overview.totalCost)} />
              <Stat label="Active Projects" value={`${overview.activeProjects}`} />
              <Stat label="Active Sessions" value={`${overview.activeSessions}`} />
            </div>
          </div>
          <div className="usage-activity__chart">
            {chart}
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="usage-section">
        <div className="usage-section__header">
          <h3 className="section-label !p-0">Providers</h3>
        </div>
        <div className="usage-list">
          {overview.providers.map((provider) => {
            const logoSrc = assistantLogoSrc[provider.provider];
            return (
              <div key={provider.provider} className="usage-list__row">
                <div className="usage-list__info">
                  <span className="usage-list__label usage-list__label--provider">
                    {logoSrc ? <img src={logoSrc} alt="" className={`usage-list__icon ${getAssistantLogoClass(provider.provider) ?? ""}`} /> : null}
                    {getProviderLabel(provider.provider)}
                  </span>
                  <span className="usage-list__meta">{formatPercent(provider.sharePercent)} of total</span>
                </div>
                <div className="usage-list__values">
                  <div className="usage-list__sparkline-wrap">
                    <Sparkline values={provider.trend} />
                  </div>
                  <span className="usage-list__metric">{presentCost(provider.cost)}</span>
                  <strong className="usage-list__metric usage-list__metric--primary">{formatTokenCount(provider.tokens)}</strong>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <ProviderLimits snapshots={snapshots} window={overview.window as TimeWindow} />

      <hr className="settings-divider" />

      <BreakdownList
        title="Tool Breakdown"
        emptyLabel="No model activity yet for this window."
        items={overview.topModels}
        withSparklines
      />

      <hr className="settings-divider" />

      <BreakdownList
        title="Project Breakdown"
        emptyLabel="No project activity yet for this window."
        items={overview.topProjects}
        showSessions
        withSparklines
      />

      <hr className="settings-divider" />

      <section className="usage-section">
        <div className="usage-section__header">
          <h3 className="section-label !p-0">Methodology</h3>
        </div>
        <ul className="usage-methodology">
          <li>Usage totals and breakdowns on this screen are based on locally observed activity from this machine.</li>
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
    <div className="absolute inset-0 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-label !p-0">Usage</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={handleRefresh}
          aria-label="Refresh usage"
        >
          <RefreshCcw size={14} className={isBusy ? "animate-spin" : ""} />
        </button>
      </div>

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
