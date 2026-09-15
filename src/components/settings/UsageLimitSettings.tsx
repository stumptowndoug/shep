import type { ConfigurableUsageProvider, UsageSettings } from "../../lib/types";
import type { UsageLimitKey } from "../../lib/usageLimitSettings";

const LIMITS: Partial<Record<ConfigurableUsageProvider, { label: string; keys: [UsageLimitKey, UsageLimitKey] }>> = {
  claude: { label: "Claude", keys: ["showClaudeFiveHourLimit", "showClaudeWeeklyLimit"] },
  antigravity: { label: "Gemini", keys: ["showAntigravityGeminiFiveHourLimit", "showAntigravityGeminiWeeklyLimit"] },
};

export function UsageLimitSettings({ provider, settings, saving, onChange }: {
  provider: ConfigurableUsageProvider;
  settings: UsageSettings;
  saving: boolean;
  onChange: (key: UsageLimitKey, show: boolean) => void;
}) {
  const limits = LIMITS[provider];
  if (!limits || !settings[provider].show || settings[provider].budgetMode !== "subscription") return null;
  return (
    <div className="usage-provider-limits" role="group" aria-label={`${limits.label} utilization limits`}>
      {limits.keys.map((key, index) => (
        <button type="button" key={key} tabIndex={0} disabled={saving}
          className={`option-card option-card--compact ${settings[key] ? "selected" : ""}`}
          aria-label={`${limits.label} ${index === 0 ? "5h" : "7D"} limit`}
          aria-pressed={settings[key]}
          title={`${settings[key] ? "Hide" : "Show"} ${limits.label} ${index === 0 ? "5-hour" : "7-day"} usage in utilization`}
          onClick={() => onChange(key, !settings[key])}>
          {index === 0 ? "5h" : "7D"}
        </button>
      ))}
    </div>
  );
}
