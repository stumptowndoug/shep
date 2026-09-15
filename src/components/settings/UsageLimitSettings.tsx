import { useEffect, useRef } from "react";
import type { ConfigurableUsageProvider, UsageSettings } from "../../lib/types";
import type { UsageLimitKey } from "../../lib/usageLimitSettings";

const ROWS: { provider: "antigravity" | "claude"; label: string; weekly: UsageLimitKey; fiveHour: UsageLimitKey }[] = [
  { provider: "antigravity", label: "Gemini", weekly: "showAntigravityGeminiWeeklyLimit", fiveHour: "showAntigravityGeminiFiveHourLimit" },
  { provider: "claude", label: "Claude", weekly: "showClaudeWeeklyLimit", fiveHour: "showClaudeFiveHourLimit" },
];

export function UsageLimitSettings({ provider, settings, saving, onChange }: {
  provider: ConfigurableUsageProvider;
  settings: UsageSettings;
  saving: boolean;
  onChange: (key: UsageLimitKey, show: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      container.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((details) => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const config = settings[provider];
  const rows = config.show && config.budgetMode === "subscription"
    ? ROWS.filter((row) => row.provider === provider) : [];
  return (
    <div className="usage-provider-limits" ref={container}>
      {rows.map((row) => (
        <div className="usage-provider-limits__row" key={row.label} role="group"
          aria-label={`${provider === "antigravity" ? "Antigravity " : ""}${row.label} limits`}>
          <span className="usage-provider-limits__label">{provider === "antigravity" ? row.label : null}</span>
          <details className="usage-limit-picker"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
            onBlur={(event) => {
              // WebKit blurs to null when a button is clicked; closing here
              // would remove the target before its click can update settings.
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false;
            }}>
            <summary aria-label={`Edit ${row.label} limits`}>
              {settings[row.weekly] ? (settings[row.fiveHour] ? "Weekly + 5h" : "Weekly") : (settings[row.fiveHour] ? "5h" : "Hidden")}
              <span aria-hidden="true" className="usage-limit-picker__chevron">⌄</span>
            </summary>
            <div className="usage-limit-picker__popover" role="group" aria-label={`${row.label} shown limits`}>
            {([row.weekly, row.fiveHour] as const).map((key, index) => (
            <button type="button" key={key} tabIndex={0}
              className="usage-limit-picker__option" disabled={saving}
              aria-label={`${row.label} ${index === 0 ? "weekly" : "5-hour"} limit`}
              aria-pressed={settings[key]}
              title={`${settings[key] ? "Hide" : "Show"} ${row.label} ${index === 0 ? "weekly" : "5-hour"} usage in utilization`}
              onClick={() => onChange(key, !settings[key])}>
              <span>{index === 0 ? "Weekly" : "5h"}</span>
              <span className="usage-limit-picker__state">{settings[key] ? "Shown" : "Hidden"}</span>
            </button>
            ))}
            </div>
          </details>
        </div>
      ))}
    </div>
  );
}
