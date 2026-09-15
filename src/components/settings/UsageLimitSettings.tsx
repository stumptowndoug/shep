import type { ConfigurableUsageProvider, UsageSettings } from "../../lib/types";
import type { UsageLimitKey } from "../../lib/usageLimitSettings";

const ROWS: { provider: "antigravity" | "claude"; label: string; weekly: UsageLimitKey; fiveHour: UsageLimitKey }[] = [
  { provider: "antigravity", label: "Gemini", weekly: "showAntigravityGeminiWeeklyLimit", fiveHour: "showAntigravityGeminiFiveHourLimit" },
  { provider: "antigravity", label: "Claude + GPT", weekly: "showAntigravityClaudeWeeklyLimit", fiveHour: "showAntigravityClaudeFiveHourLimit" },
  { provider: "claude", label: "Claude", weekly: "showClaudeWeeklyLimit", fiveHour: "showClaudeFiveHourLimit" },
];

export function UsageLimitSettings({ provider, settings, saving, onChange }: {
  provider: ConfigurableUsageProvider;
  settings: UsageSettings;
  saving: boolean;
  onChange: (key: UsageLimitKey, show: boolean) => void;
}) {
  const config = settings[provider];
  const rows = config.show && config.budgetMode === "subscription"
    ? ROWS.filter((row) => row.provider === provider) : [];
  return (
    <div className="usage-provider-limits">
      {rows.map((row) => (
        <div className="usage-provider-limits__row" key={row.label} role="group"
          aria-label={`${provider === "antigravity" ? "Antigravity " : ""}${row.label} limits`}>
          <span className="usage-provider-limits__label">{provider === "antigravity" ? row.label : null}</span>
          {([row.weekly, row.fiveHour] as const).map((key, index) => (
            <button type="button" key={key}
              className="usage-limit-toggle" disabled={saving}
              aria-label={`${row.label} ${index === 0 ? "weekly" : "5-hour"} limit`}
              aria-pressed={settings[key]}
              title={`${settings[key] ? "Hide" : "Show"} ${row.label} ${index === 0 ? "weekly" : "5-hour"} usage in utilization`}
              onClick={() => onChange(key, !settings[key])}>
              {index === 0 ? "Weekly" : "5h"}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
