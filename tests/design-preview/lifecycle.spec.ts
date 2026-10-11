import { expect, test } from "@playwright/test";

for (const restart of [false, true]) {
  test(`${restart ? "restart" : "quit"} honors cancellation and uses native cleanup`, async ({ page }) => {
    await page.goto("/tests/design-preview/");
    const result = await page.evaluate(async (restart) => {
      const { requestAppShutdown } = await import("/src/lib/appLifecycle.ts");
      const base = window.__TAURI_INTERNALS__.invoke;
      const calls: { cmd: string; args: unknown }[] = [];
      let confirmed = false;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
        if (cmd === "get_pty_session_count") return 2;
        if (cmd === "plugin:dialog|message") { calls.push({ cmd, args }); return confirmed ? (restart ? "Restart" : "Quit") : "Cancel"; }
        if (cmd === "shutdown_and_quit" || cmd === "plugin:process|restart") { calls.push({ cmd, args }); return; }
        return base(cmd, args, ...rest);
      };
      await requestAppShutdown(restart);
      const cancelled = calls.filter(call => call.cmd === "shutdown_and_quit").length;
      confirmed = true;
      await requestAppShutdown(restart);
      return { cancelled, shutdowns: calls.filter(call => call.cmd === "shutdown_and_quit"), bypasses: calls.filter(call => call.cmd === "plugin:process|restart") };
    }, restart);
    expect(result.cancelled).toBe(0);
    expect(result.shutdowns).toEqual([{ cmd: "shutdown_and_quit", args: { restart } }]);
    expect(result.bypasses).toEqual([]);
  });
}
