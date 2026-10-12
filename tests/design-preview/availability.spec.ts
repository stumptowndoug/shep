import { expect, test } from "@playwright/test";

test("pending checks never present installed chat as terminal-only or offer reinstall", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed&availability=slow");
  const claude = page.getByRole("button", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Checking");
  await claude.click();
  await expect(page.getByText("Set up Claude Code to use chat.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start Claude Code", exact: true })).toBeDisabled();
  await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.release());
  await expect(claude).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  expect(await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.calls.filter(key => key === "cursor-agent").length)).toBe(1);
});

test("one slow runtime verification does not hold back other installed adapters", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed&availability=slow-runtime");
  await expect(page.getByRole("button", { name: "Claude Code", exact: true })).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Codex", exact: true })).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Antigravity", exact: true })).toContainText("Checking");
  await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.release());
  await expect(page.getByRole("button", { name: "Antigravity", exact: true })).toContainText("Chat");
});

test("returning from a working chat preserves installation results during a recheck", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed");
  const claude = page.getByRole("button", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Chat & terminal");
  await page.evaluate(async () => {
    const { useTerminalStore } = await import("/src/stores/useTerminalStore.ts");
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({...chat, status:"working"}));
    useTerminalStore.getState().setActiveTab("preview-900");
    (await import("./availabilityPreview.ts")).availabilityPreview.paused = true;
    void (await import("/src/stores/useAgentAvailabilityStore.ts")).useAgentAvailabilityStore.getState().refresh(true);
  });
  await expect(claude).toHaveCount(0);
  await page.getByRole("button", { name: "New agent", exact: true }).first().click();
  await expect(claude).toContainText("Chat & terminal");
  await claude.click();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await expect(page.getByText("Set up Claude Code to use chat.")).toHaveCount(0);
  expect(await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.calls.filter(key => key === "claude-agent-acp").length)).toBe(2);
});

test("an availability error keeps confirmed installations and provides retry", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed");
  const claude = page.getByRole("button", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Chat & terminal");
  await claude.click();
  await page.evaluate(async () => {
    (await import("./availabilityPreview.ts")).availabilityPreview.failures.add("claude-agent-acp");
    await (await import("/src/stores/useAgentAvailabilityStore.ts")).useAgentAvailabilityStore.getState().refresh(true);
  });
  await expect(claude).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("Couldn’t check agent availability");
  await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.failures.clear());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed initial check is not a missing adapter", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed&availability=error");
  const claude = page.getByRole("button", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Couldn’t check availability");
  await claude.click();
  await expect(page.getByText("Set up Claude Code to use chat.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start Claude Code", exact: true })).toBeDisabled();
  await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.failures.clear());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(claude).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
});

test("returning from an external install discovers the newly available chat adapter", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  const codex = page.getByRole("button", { name: "Codex", exact: true });
  await expect(codex.locator(".agent-tab__status")).toHaveText("Terminal");
  await codex.click();
  await expect(page.getByText("Set up Codex to use chat.")).toBeVisible();
  await page.evaluate(async () => {
    (await import("./availabilityPreview.ts")).availabilityPreview.commands.set("codex-acp", true);
    window.dispatchEvent(new Event("focus"));
  });
  await expect(codex).toContainText("Chat & terminal");
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await expect(page.getByText("Set up Codex to use chat.")).toHaveCount(0);
});

test("an older missing result cannot overwrite a successful runtime installation", async ({ page }) => {
  await page.goto("/tests/design-preview/?adapter=missing");
  const antigravity = page.getByRole("button", { name: "Antigravity", exact: true });
  await expect(antigravity).toContainText("Set up chat");
  await antigravity.click();
  await page.evaluate(async () => {
    (await import("./availabilityPreview.ts")).availabilityPreview.paused = true;
    void (await import("/src/stores/useAgentAvailabilityStore.ts")).useAgentAvailabilityStore.getState().refresh(true);
  });
  await page.getByRole("button", { name: "Install chat runtime", exact: true }).click();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await page.evaluate(async () => (await import("./availabilityPreview.ts")).availabilityPreview.release());
  await expect.poll(() => page.evaluate(async () => {
    const { useAgentAvailabilityStore } = await import("/src/stores/useAgentAvailabilityStore.ts");
    return Object.values(useAgentAvailabilityStore.getState().checks).every(check => !check.checking);
  })).toBe(true);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Install chat runtime", exact: true })).toHaveCount(0);
});

for (const [name, command, owner] of [["Claude Code", "claude-agent-acp", "Claude"], ["Codex", "codex-acp", "Codex"], ["pi", "pi-acp", "pi"]]) {
  test(`${name} chat installs inside Shep with one click instead of a terminal`, async ({ page }) => {
    await page.goto("/tests/design-preview/");
    await page.evaluate(async (command) => {
      (await import("./availabilityPreview.ts")).availabilityPreview.commands.set(command, false);
      await (await import("/src/stores/useAgentAvailabilityStore.ts")).useAgentAvailabilityStore.getState().refresh(true);
    }, command);
    const agent = page.getByRole("button", { name, exact: true });
    await expect(agent.locator(".agent-tab__status")).toHaveText("Terminal");
    await agent.click();
    await expect(page.getByText(`Installs ${owner}’s chat adapter inside Shep with npm. Needs Node.js.`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up in terminal", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Install chat adapter", exact: true }).click();
    await expect(agent).toContainText("Chat & terminal");
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled();
    await expect(page.getByText(`Set up ${name} to use chat.`)).toHaveCount(0);
  });
}

test("a missing Node.js install explains what to do", async ({ page }) => {
  await page.goto("/tests/design-preview/?install=no-node");
  await page.evaluate(async () => {
    (await import("./availabilityPreview.ts")).availabilityPreview.commands.set("claude-agent-acp", false);
    await (await import("/src/stores/useAgentAvailabilityStore.ts")).useAgentAvailabilityStore.getState().refresh(true);
  });
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Install chat adapter", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Chat needs Node.js");
  await expect(page.getByRole("button", { name: "Install chat adapter", exact: true })).toBeEnabled();
});
