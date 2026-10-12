import { mockAntigravityCommand } from "../antigravity-chat/mockAntigravity";

const params = new URLSearchParams(location.search);
export const availabilityPreview = {
  paused: params.get("availability") === "slow",
  blocked: new Set(params.get("availability") === "slow-runtime" ? ["managed:antigravity"] : []),
  failures: new Set(params.get("availability") === "error" ? ["claude-agent-acp"] : []),
  commands: new Map<string, boolean>(),
  calls: [] as string[],
  pending: [] as { key: string; finish: () => void }[],
  release() {
    this.paused = false;
    this.blocked.clear();
    for (const pending of this.pending.splice(0)) pending.finish();
  },
};

// npm adapters Shep can install itself, checked by the command they install.
const npmAdapters: Record<string, string> = { claude: "claude-agent-acp", codex: "codex-acp", pi: "pi-acp" };

export function mockAvailability(cmd: string, args: Record<string, unknown>) {
  const managed = cmd === "get_managed_acp_adapter";
  const npmCommand = managed ? npmAdapters[String(args.adapter)] : undefined;
  const key = npmCommand ?? (managed ? `managed:${args.adapter}` : String(args.command));
  availabilityPreview.calls.push(key);
  // Capture the result when the check starts, to reproduce a stale result
  // arriving after a successful install.
  const found = availabilityPreview.commands.get(key) ?? (params.get("agents") === "installed" ? key !== "agy"
    : !["grok", "agy", "codex-acp"].includes(key));
  const result = npmCommand ? found ? { command: `/test/bin/${npmCommand}`, args: [] } : null
    : managed ? mockAntigravityCommand(cmd, args) : found;
  const failed = availabilityPreview.failures.has(key);
  return new Promise((resolve, reject) => {
    const finish = () => failed ? reject(new Error("Availability check failed")) : resolve(result);
    if (availabilityPreview.paused || availabilityPreview.blocked.has(key)) availabilityPreview.pending.push({ key, finish });
    else finish();
  });
}
