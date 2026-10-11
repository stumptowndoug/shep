import { expect, test } from "@playwright/test";

test("a command that exits during startup stays stopped", async ({ page }) => {
  await page.goto("/tests/design-preview/?autostart=1&cold=1&pty=exit");
  await expect.poll(() => page.evaluate(async () => {
    const terminals = (await import("/src/stores/useTerminalStore.ts")).useTerminalStore.getState();
    const commands = (await import("/src/stores/useCommandStore.ts")).useCommandStore.getState();
    const tab = terminals.projectState["/preview/shep"]?.tabs.find(tab => tab.commandName === "serve");
    const command = commands.projectCommands["/preview/shep"]?.find(command => command.name === "serve");
    return {status:command?.status,ptyId:command?.ptyId,alive:tab && terminals.tabActivity[tab.ptyId]?.alive};
  })).toEqual({status:"stopped",ptyId:null,alive:false});
});

for (const cold of [false, true]) {
  test(`autostart uses the selected project on ${cold ? "initial restore" : "switch"}`, async ({ page }) => {
    if (cold) await page.addInitScript(() => localStorage.setItem("shep:last-repo-path", "/preview/springroll"));
    await page.goto(`/tests/design-preview/?autostart=1${cold ? "&cold=1" : ""}`);
    if (!cold) {
      await page.evaluate(async () => (await import("/src/stores/useUIStore.ts")).useUIStore.getState().setProjectSwitcherOpen(true));
      await page.getByRole("textbox", { name: "Search projects" }).fill("springroll");
      await page.getByRole("textbox", { name: "Search projects" }).press("Enter");
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.previewLastSession)).toBeTruthy();
    const result = await page.evaluate(async () => {
      const terminals = (await import("/src/stores/useTerminalStore.ts")).useTerminalStore.getState();
      const commands = (await import("/src/stores/useCommandStore.ts")).useCommandStore.getState();
      return {
        spawn: JSON.parse(document.documentElement.dataset.previewLastSession!),
        tab: terminals.projectState["/preview/springroll"]?.tabs.find(tab => tab.commandName === "serve"),
        command: commands.projectCommands["/preview/springroll"]?.find(command => command.name === "serve"),
      };
    });
    expect(result.spawn.cwd).toBe("/preview/springroll/app");
    expect(result.tab.repoPath).toBe("/preview/springroll");
    expect(result.command.status).toBe("running");
    expect(result.command.ptyId).toBe(result.tab.ptyId);
  });
}

for (const removed of [false, true]) {
  test(`a delayed agent launch ${removed ? "cleans up after project removal" : "stays in its original project"}`, async ({ page }) => {
    await page.goto("/tests/design-preview/");
    const result = await page.evaluate(async (removed) => {
      const { startChat, closeChat } = await import("/src/lib/acp/chatSessions.ts");
      const { useTerminalStore: store } = await import("/src/stores/useTerminalStore.ts");
      const { CODING_ASSISTANTS } = await import("/src/components/sidebar/constants.ts");
      const base = window.__TAURI_INTERNALS__.invoke;
      let finish: ((id: number) => void) | undefined;
      const killed: number[] = [];
      window.__TAURI_INTERNALS__.invoke = async (cmd, args, ...rest) => {
        if (cmd === "spawn_acp_agent") return new Promise(resolve => { finish = resolve; });
        if (cmd === "kill_acp_agent") { killed.push(args.agentId); return; }
        if (cmd === "write_acp_agent") return;
        return base(cmd, args, ...rest);
      };
      const starting = startChat({assistant:CODING_ASSISTANTS[0],repoPath:"/preview/shep",mode:"standard"});
      while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
      store.getState().switchProject("/preview/springroll");
      if (removed) store.getState().removeProject("/preview/shep");
      finish(9876);
      let error: string | null = null;
      try { await starting; } catch (e) { error = String(e); }
      const owner = Object.entries(store.getState().projectState).find(([,state]) => state.tabs.some(tab => tab.ptyId === 9876))?.[0] ?? null;
      const activity = Boolean(store.getState().tabActivity[9876]);
      const beforeCleanup = [...killed];
      if (!removed) await closeChat(9876);
      return {owner,activity,killed:beforeCleanup,error};
    }, removed);
    expect(result.owner).toBe(removed ? null : "/preview/shep");
    expect(result.activity).toBe(!removed);
    expect(result.killed).toEqual(removed ? [9876] : []);
    expect(Boolean(result.error)).toBe(removed);
  });
}
