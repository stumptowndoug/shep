// Synthetic browser profile: no native agents, credentials, or user data.
// Start Vite first, then: node scripts/profile-chat-memory.mjs http://127.0.0.1:5176
import { chromium, expect } from "@playwright/test";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5176");
if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw new Error("Use a local Vite fixture server.");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(new URL("/tests/design-preview/?view=chat", origin).href);
  await expect(page.locator(".chat-view:visible")).toBeVisible();
  const measurements = [];
  const measure = async (label) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const values = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
    const sample = { label, heapMiB: values.JSHeapUsedSize / 1048576, nodes: values.Nodes };
    measurements.push(sample);
    console.log(JSON.stringify(sample));
  };
  await measure("baseline");
  for (let cycle = 1; cycle <= 3; cycle++) {
    await page.evaluate(async () => {
      const { useTerminalStore } = await import("/src/stores/useTerminalStore.ts");
      const { useChatStore } = await import("/src/stores/useChatStore.ts");
      const terminals = useTerminalStore.getState();
      if (!terminals.findTabByPtyId(900)) terminals.addTab({
        id: "preview-900", kind: "assistant", label: "Memory profile", labelSource: "user", ptyId: 900,
        agentInterface: "chat", repoPath: "/preview/shep", commandName: null, assistantId: "claude",
        providerSessionId: null, sessionMode: "standard",
      });
      else terminals.updateTab("preview-900", { label: "Memory profile", labelSource: "user" });
      terminals.setActiveTab("preview-900");
      useChatStore.getState().init(900);
    });
    for (const count of [500, 1000, 2000]) {
      await page.evaluate(async ({ count, cycle }) => {
        const { useChatStore } = await import("/src/stores/useChatStore.ts");
        useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [
          ...chat.turns,
          ...Array.from({ length: count - chat.turns.length }, (_, index) => {
            const id = index + chat.turns.length;
            return { id, prompt: `Prompt ${cycle}-${id}`, startedAt: 1, endedAt: 2, stopReason: "end_turn", items: [
              { kind: "tool", id: `tool-${id}`, title: "Read file", toolKind: "read", status: "completed",
                // Force independent flat strings, like incoming JSON, under the
                // real 24,000-character tool-output limit. No shared rope shortcut.
                output: JSON.parse(JSON.stringify(`${cycle}-${id} ` + "synthetic log\n".repeat(1750))), diffs: [] },
              { kind: "message", id: `answer-${id}`, messageId: null, text: `Answer ${cycle}-${id}` },
            ] };
          }),
        ] }));
      }, { count, cycle });
      await expect(page.locator(".chat-view:visible .chat-turn")).toHaveCount(50);
      await measure(`cycle${cycle}-${count}turns`);
    }
    // Exercise the actual UI close path, including tab removal and unmounting.
    const close = page.getByRole("button", { name: /^Close tab memory profile$/i });
    await close.click();
    await expect(close).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () =>
      Boolean((await import("/src/stores/useChatStore.ts")).useChatStore.getState().chats[900]),
    )).toBe(false);
    await measure(`cycle${cycle}-closed`);
  }
  console.log(JSON.stringify({
    scope: "Chromium JS heap after GC; excludes native/WebKit/GPU memory and live provider processes",
    closedGrowthMiB: measurements.at(-1).heapMiB - measurements[0].heapMiB,
  }));
} finally {
  await browser.close();
}
