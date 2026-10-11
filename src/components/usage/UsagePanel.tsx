import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Folder, RefreshCcw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getUsageOverview, refreshUsageData } from "../../lib/tauri";
import type { UsageOverview, UsageProvider, UsageTrendBucket, UsageSettings, ProviderUsageSnapshot } from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useUsageStore, type TimeWindow } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useGitStore } from "../../stores/useGitStore";
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
  hasVisibleUsageLimits,
  type PaceStatus,
} from "./usageHelpers";
import { groupModels, matchProjects, type UsageTotals } from "./usageLabels";
import { getErrorMessage } from "../../lib/errors";

const TIME_WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "365d", label: "1y" },
];

const WINDOW_PHRASE: Record<TimeWindow, string> = {
  "24h": "in the last 24 hours",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  "365d": "in the last year",
};

/** Provider window labels ("5h", "7d", "24h pro") as words. */
function limitLabel(label: string): string {
  const [span, ...rest] = label.trim().split(/\s+/);
  const word = ({ "5h": "5-hour", "24h": "Daily", "7d": "Weekly", "30d": "Monthly" } as Record<string, string>)[span];
  return word ? [word, ...rest].join(" ") : label;
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function ProviderLogo({ provider }: { provider: UsageProvider }) {
  const src = assistantLogoSrc[provider];
  return src
    ? <img src={src} alt="" className={`usage-logo ${getAssistantLogoClass(provider) ?? ""}`} />
    : <span className="usage-logo" aria-hidden="true" />;
}

const breakdownTitle = (totals: UsageTotals) =>
  `Input ${formatTokenCount(totals.input)} · Output ${formatTokenCount(totals.output)} · Cache ${formatTokenCount(totals.cache)}`;

// ── Activity chart ───────────────────────────────────────

function bucketDates(window: TimeWindow, count: number): Date[] {
  const base = new Date();
  if (window === "24h") base.setMinutes(0, 0, 0);
  else base.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(base);
    if (window === "24h") date.setHours(base.getHours() - (count - 1 - index));
    else date.setDate(base.getDate() - (count - 1 - index));
    return date;
  });
}

function cellFill(tokens: number, max: number): string {
  if (tokens === 0) return "var(--usage-empty)";
  const intensity = Math.max(tokens / max, 0.12);
  return `color-mix(in srgb, var(--accent) ${Math.round(18 + intensity * 72)}%, transparent)`;
}

function ActivityChart({ trend, window, onHover }: { trend: UsageTrendBucket[]; window: TimeWindow; onHover: (text: string | null) => void }) {
  const setHover = onHover;
  const dates = bucketDates(window, trend.length);
  const max = Math.max(...trend.map((bucket) => bucket.tokens), 1);
  const describe = (index: number) => {
    const date = dates[index];
    const when = window === "24h"
      ? date.toLocaleString([], { weekday: "short", hour: "numeric" })
      : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return `${when} · ${formatTokenCount(trend[index].tokens)} tokens`;
  };

  if (window === "365d") {
    const leading = dates[0]?.getDay() ?? 0;
    const months = Array.from({ length: Math.ceil((leading + dates.length) / 7) }, (_, week) => {
      const first = dates.slice(Math.max(week * 7 - leading, 0), week * 7 - leading + 7).find((date) => date.getDate() === 1);
      return first ? first.toLocaleDateString([], { month: "short" }) : "";
    });
    return (
      <div className="usage-heatmap">
        <div className="usage-heatmap__scroll">
          <div className="usage-heatmap__months" aria-hidden="true">
            {months.map((label, index) => <span key={index}>{label}</span>)}
          </div>
          <div className="usage-heatmap__grid" aria-hidden="true">
            {Array.from({ length: leading }, (_, index) => <span key={`pad-${index}`} />)}
            {trend.map((bucket, index) => (
              <span
                key={bucket.start}
                className="usage-heatmap__cell"
                style={{ background: cellFill(bucket.tokens, max) }}
                onMouseEnter={() => setHover(describe(index))}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="usage-chart">
      <div className="usage-chart__bars" aria-hidden="true">
        {trend.map((bucket, index) => (
          <div
            key={bucket.start}
            className="usage-chart__col"
            onMouseEnter={() => setHover(describe(index))}
            onMouseLeave={() => setHover(null)}
          >
            <div className="usage-chart__track">
              <div
                className="usage-chart__bar"
                style={{
                  height: bucket.tokens === 0 ? 3 : `${Math.max((bucket.tokens / max) * 100, 4)}%`,
                  background: cellFill(bucket.tokens, max),
                }}
              />
            </div>
            <span className="usage-chart__tick">
              {window === "24h"
                ? index % 4 === 0 ? dates[index].toLocaleTimeString([], { hour: "numeric" }) : ""
                : window === "30d"
                  ? index % 5 === 0 ? dates[index].toLocaleDateString([], { month: "short", day: "numeric" }) : ""
                  : dates[index].toLocaleDateString([], { weekday: "short" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Limits ───────────────────────────────────────────────

interface LimitItem {
  id: string;
  provider: UsageProvider;
  label: string;
  pct: number | null;
  /** Shown instead of the bar while a provider loads or fails. */
  status?: string;
  detail: string;
  pace: { status: PaceStatus; elapsedPct: number } | null;
}

function collectLimits(snapshots: Record<string, ProviderUsageSnapshot>, settings: UsageSettings): LimitItem[] {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const elapsedMonthPct = ((now.getTime() - monthStart.getTime()) / (nextMonth.getTime() - monthStart.getTime())) * 100;
  const items: LimitItem[] = [];

  for (const provider of ALL_USAGE_PROVIDERS) {
    const config = settings[provider];
    const snap = snapshots[provider];
    if (!config.show) continue;

    // A monthly budget is a limit the user set themselves.
    if (config.budgetMode === "custom") {
      if (config.monthlyBudget == null || config.monthlyBudget <= 0) continue;
      const spent = snap?.localDetails?.costMonth ?? 0;
      const pct = (spent / config.monthlyBudget) * 100;
      const delta = pct - elapsedMonthPct;
      items.push({
        id: `budget-${provider}`,
        provider,
        label: "Monthly budget",
        pct,
        detail: `${formatCost(spent)} of ${formatCost(config.monthlyBudget)}`,
        pace: { status: delta <= -10 ? "under" : delta >= 10 ? "over" : "on", elapsedPct: elapsedMonthPct },
      });
      continue;
    }

    if (!hasVisibleUsageLimits(provider, settings)) continue;
    const reported = (snap?.summaryWindows ?? []).filter((w) => w.sourceType === "provider" && w.usedPercent != null);
    const windows = reported.filter((w) => shouldShowUsageWindow(provider, w.window, settings, w.windowId));
    if (windows.length === 0) {
      if (reported.length === 0) {
        items.push({ id: `pending-${provider}`, provider, label: "", pct: null, status: snap?.error ?? "Checking…", detail: "", pace: null });
      }
      continue;
    }
    for (const w of windows) {
      items.push({
        id: w.windowId,
        provider,
        label: limitLabel(w.label),
        pct: w.usedPercent,
        detail: w.resetAt ? `Resets in ${formatReset(w.resetAt)}` : "",
        pace: computePace(w),
      });
    }
  }
  return items.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

function LimitsSection({ items }: { items: LimitItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="page__section">
      <div className="usage-label"><span>Limits</span></div>
      <ul className="usage-list">
        {items.map((item) => {
          const tone = barTone(item.pace, item.pct);
          return (
            <li key={item.id} className="usage-limit">
              <span className="usage-row__name">
                <ProviderLogo provider={item.provider} />
                <span className="usage-row__label">{getProviderLabel(item.provider)}</span>
                {item.label && <span className="usage-row__sub">{item.label}</span>}
              </span>
              {item.status ? (
                <span className="usage-limit__status">{item.status}</span>
              ) : (
                <>
                  <span
                    className="usage-limit__bar"
                    style={{ background: TONE_TRACK[tone] }}
                    title={item.pace ? `${formatPercent(item.pace.elapsedPct)} of the window has passed; ${paceLabel(item.pace.status)}` : undefined}
                  >
                    <span className="usage-limit__fill" style={{ width: `${Math.min(item.pct ?? 0, 100)}%`, background: TONE_COLORS[tone] }} />
                    {item.pace && <span className="usage-limit__pace" style={{ left: `${Math.min(item.pace.elapsedPct, 100)}%` }} />}
                  </span>
                  <span className="usage-row__value">{formatPercent(item.pct)}</span>
                  <span className="usage-limit__detail">{item.detail}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Breakdowns ───────────────────────────────────────────

interface ShareRowData extends UsageTotals {
  key: string;
  icon: ReactNode;
  name: string;
  sub?: ReactNode;
  muted?: boolean;
}

/** Agents, models, and projects share one row: name, relative bar, share, tokens. */
function ShareList({ label, rows, total, empty }: { label: string; rows: ShareRowData[]; total: number; empty: string }) {
  const max = Math.max(...rows.filter((row) => !row.muted).map((row) => row.tokens), 1);
  return (
    <section className="page__section">
      <div className="usage-label"><span>{label}</span></div>
      {rows.length === 0 ? (
        <p className="usage-empty">{empty}</p>
      ) : (
        <ul className="usage-list">
          {rows.map((row) => (
            <li key={row.key} className={`usage-row ${row.muted ? "usage-row--muted" : ""}`} title={breakdownTitle(row)}>
              <span className="usage-row__name">
                {row.icon}
                <span className="usage-row__label">{row.name}</span>
                {row.sub && <span className="usage-row__sub">{row.sub}</span>}
              </span>
              <span className="usage-row__bar" aria-hidden="true">
                {!row.muted && <span style={{ width: `${Math.max((row.tokens / max) * 100, 1)}%` }} />}
              </span>
              <span className="usage-row__share">{total > 0 ? formatPercent((row.tokens / total) * 100) : ""}</span>
              <span className="usage-row__value">{formatTokenCount(row.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Overview({ overview, snapshots }: { overview: UsageOverview; snapshots: Record<string, ProviderUsageSnapshot> }) {
  const settings = useUsageSettingsStore((s) => s.settings);
  const repos = useRepoStore((s) => s.repos);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const window = overview.window as TimeWindow;
  const limits = collectLimits(snapshots, settings);
  // Hovering the chart shows that hour or day in place of the window total.
  const [hover, setHover] = useState<string | null>(null);
  const total = overview.totalTokens;

  const agents = useMemo<ShareRowData[]>(() =>
    [...overview.providers]
      .filter((provider) => provider.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((provider) => ({
        key: provider.provider,
        icon: <ProviderLogo provider={provider.provider} />,
        name: getProviderLabel(provider.provider),
        tokens: provider.tokens,
        input: provider.tokensInput,
        output: provider.tokensOutput,
        cache: provider.tokensCacheRead + provider.tokensCacheWrite,
      })),
  [overview.providers]);

  const models = useMemo<ShareRowData[]>(() =>
    groupModels(overview.topModels).map((model) => ({ ...model, icon: <ProviderLogo provider={model.provider} /> })),
  [overview.topModels]);

  const projects = useMemo<ShareRowData[]>(() => {
    const { rows, other } = matchProjects(overview.topProjects, repos, gitStatuses);
    const list: ShareRowData[] = rows.map((row) => ({
      ...row,
      key: row.repo.path,
      icon: <Folder size={15} className="usage-row__icon" aria-hidden="true" />,
      name: row.repo.name,
      sub: (
        <span className="usage-row__agents">
          {row.providers.map((provider) => <ProviderLogo key={provider} provider={provider} />)}
        </span>
      ),
    }));
    if (other.tokens > 0) {
      list.push({
        ...other,
        key: "other",
        icon: <Folder size={15} className="usage-row__icon" aria-hidden="true" />,
        name: "Other folders",
        sub: other.folders > 0 ? plural(other.folders, "folder") : undefined,
        muted: true,
      });
    }
    const cursor = overview.providers.find(provider => provider.provider === "cursor");
    if (cursor && cursor.tokens > 0) list.push({
      key: "cursor-unassigned", name: "Cursor — project unavailable", icon: <ProviderLogo provider="cursor" />,
      tokens: cursor.tokens, input: cursor.tokensInput, output: cursor.tokensOutput,
      cache: cursor.tokensCacheRead + cursor.tokensCacheWrite, muted: true,
    });
    return list;
  }, [overview.topProjects, overview.providers, repos, gitStatuses]);

  return (
    <>
      <LimitsSection items={limits} />

      <section className="page__section">
        <div className="usage-label">
          <span>Activity</span>
          <span className="usage-label__value">
            {hover ?? `${formatTokenCount(total)} tokens · ${plural(overview.activeSessions, "session")}`}
          </span>
        </div>
        <div className="usage-card">
          <ActivityChart trend={overview.trend} window={window} onHover={setHover} />
        </div>
      </section>

      <ShareList label="Agents" rows={agents} total={total} empty={`No agent activity ${WINDOW_PHRASE[window]}.`} />
      <ShareList label="Models" rows={models} total={total} empty={`No model activity ${WINDOW_PHRASE[window]}.`} />
      <ShareList label="Projects" rows={projects} total={total} empty={`No project activity ${WINDOW_PHRASE[window]}.`} />

      <p className="page__note usage-footnote">
        Token counts come from your agents’ session logs on this Mac; Cursor reports its own totals and has no project
        detail. Limits come from each provider, so they won’t always line up with these counts.
      </p>
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
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const overviewRequest = useRef(0);

  const loadOverview = useCallback(async (key: TimeWindow) => {
    const request = ++overviewRequest.current;
    setOverviewLoading(true);
    setOverviewError(null);
    setOverview(previous => previous?.window === key ? previous : null);
    try {
      const result = await getUsageOverview(key);
      if (request === overviewRequest.current) setOverview(result);
    } catch (error) {
      if (request === overviewRequest.current) setOverviewError(getErrorMessage(error));
    } finally {
      if (request === overviewRequest.current) setOverviewLoading(false);
    }
  }, []);

  // Fetch overview on initial mount
  useEffect(() => {
    void loadOverview(useUsageStore.getState().window);
    return () => { overviewRequest.current++; };
  }, [loadOverview]);

  // Auto-refresh when background ingest completes
  useEffect(() => {
    const unlisten = listen("usage-ingest-complete", () => {
      void loadOverview(useUsageStore.getState().window);
    });
    return () => { unlisten.then((f) => f()); };
  }, [loadOverview]);

  const handleRefresh = async () => {
    try {
      await refreshUsageData();
      void fetchSnapshots();
      void loadOverview(useUsageStore.getState().window);
    } catch (error) {
      setOverviewError(getErrorMessage(error));
    }
  };

  const isBusy = loading || overviewLoading;

  return (
    <div className="page usage-page">
      <header className="page__heading page__heading--actions">
        <div>
          <h1 className="page__title">Usage.</h1>
          <p className="page__lede">How much your agents have worked {WINDOW_PHRASE[window]}, and how close you are to each plan’s limits.</p>
        </div>
        <div className="usage-page__actions">
          <div className="page-tabs usage-page__windows" role="group" aria-label="Time window">
            {TIME_WINDOWS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={window === option.key ? "on" : ""}
                aria-pressed={window === option.key}
                onClick={() => {
                  setWindow(option.key);
                  void loadOverview(option.key);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={handleRefresh} title="Refresh" aria-label="Refresh usage">
            <RefreshCcw size={14} className={isBusy ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {overviewError && <div className="usage-empty" role="alert">
        <p>Couldn’t load usage: {overviewError}</p>
        <button className="btn-secondary" onClick={() => void loadOverview(window)}>Retry</button>
      </div>}
      {overview ? (
        <Overview overview={overview} snapshots={snapshots} />
      ) : !overviewError && (
        <p className="usage-empty">Loading usage…</p>
      )}
    </div>
  );
}
