import { useState } from "react";
import { createRoot } from "react-dom/client";
import { UsageLimitSettings } from "../../src/components/settings/UsageLimitSettings";
import { DEFAULT_USAGE_LIMITS } from "../../src/lib/usageLimitSettings";
import type { UsageSettings, ProviderBudgetConfig } from "../../src/lib/types";
import "../../src/styles/globals.css";

const provider: ProviderBudgetConfig = { show: true, budgetMode: "subscription", monthlyBudget: null };
function Harness() {
  const [settings, setSettings] = useState<UsageSettings>({
    ...DEFAULT_USAGE_LIMITS,
    claude: provider, antigravity: provider, codex: provider, cursor: provider,
    opencode: provider, pi: provider, grok: provider,
  });
  const [saving, setSaving] = useState(false);
  return <main className="p-6" style={{ maxWidth: 820 }}>
    <section className="settings-section">
      <div className="flex items-center justify-between settings-section__header">
        <h2 className="section-label !p-0">Usage Providers</h2>
        <span className="usage-provider-limits__heading">Show limits</span>
      </div>
      <div className="usage-provider-grid">
        {(["claude", "codex", "cursor", "antigravity", "opencode"] as const).map((key) => (
          <div className="usage-provider-row" key={key} data-testid={`provider-${key}`}>
            <span className="usage-provider-row__name capitalize">{key}</span>
            <div className="usage-provider-row__controls">
              <button className="option-card option-card--compact selected">On</button>
              <button className="option-card option-card--compact selected">Subscription</button>
              <button className="option-card option-card--compact">Custom</button>
            </div>
            <UsageLimitSettings provider={key} settings={settings} saving={saving}
              onChange={(limitKey, show) => setSettings((previous) => ({ ...previous, [limitKey]: show }))} />
          </div>
        ))}
      </div>
    </section>
    <button onClick={() => setSaving(!saving)}>Toggle saving</button>
    <button onClick={() => setSettings((previous) => ({ ...previous, antigravity: { ...provider, show: false } }))}>Hide Antigravity</button>
    <button onClick={() => setSettings((previous) => ({ ...previous, claude: { ...provider, budgetMode: "custom" } }))}>Custom Claude budget</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
