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
  return <main className="p-6 max-w-xl">
    <UsageLimitSettings settings={settings} saving={saving}
      onChange={(key, show) => setSettings((previous) => ({ ...previous, [key]: show }))} />
    <button onClick={() => setSaving(!saving)}>Toggle saving</button>
    <button onClick={() => setSettings((previous) => ({ ...previous, antigravity: { ...provider, show: false } }))}>Hide Antigravity</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
