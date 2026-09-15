import type { UsageSettings } from "../../lib/types";
import type { UsageLimitKey } from "../../lib/usageLimitSettings";

const ROWS: { provider: "antigravity" | "claude"; label: string; weekly: UsageLimitKey; fiveHour: UsageLimitKey }[] = [
  { provider: "antigravity", label: "Gemini · Antigravity", weekly: "showAntigravityGeminiWeeklyLimit", fiveHour: "showAntigravityGeminiFiveHourLimit" },
  { provider: "antigravity", label: "Claude + GPT · Antigravity", weekly: "showAntigravityClaudeWeeklyLimit", fiveHour: "showAntigravityClaudeFiveHourLimit" },
  { provider: "claude", label: "Claude Code", weekly: "showClaudeWeeklyLimit", fiveHour: "showClaudeFiveHourLimit" },
];

export function UsageLimitSettings({ settings, saving, onChange }: {
  settings: UsageSettings;
  saving: boolean;
  onChange: (key: UsageLimitKey, show: boolean) => void;
}) {
  const rows = ROWS.filter(({ provider }) => settings[provider].show && settings[provider].budgetMode === "subscription");
  if (rows.length === 0) return null;
  return (
    <div className="mt-5">
      <table className="w-full text-sm text-left">
        <caption className="text-left mb-2 text-[var(--text-muted)]">Limits shown in utilization</caption>
        <thead>
          <tr className="text-xs text-[var(--text-muted)]">
            <th scope="col" className="py-2 font-normal">Usage source</th>
            <th scope="col" className="py-2 px-3 text-center font-normal">Weekly</th>
            <th scope="col" className="py-2 px-3 text-center font-normal">5-hour</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="py-2 font-normal">{row.label}</th>
              {([row.weekly, row.fiveHour] as const).map((key, index) => (
                <td key={key} className="py-2 px-3 text-center">
                  <input type="checkbox" className="cursor-pointer" disabled={saving}
                    aria-label={`${row.label} ${index === 0 ? "weekly" : "5-hour"} limit`}
                    checked={settings[key]} onChange={(event) => onChange(key, event.target.checked)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-[var(--text-muted)] mt-2">
        Choose each limit independently. Antigravity’s Claude + GPT pool is separate from your Claude Code subscription.
      </p>
    </div>
  );
}
