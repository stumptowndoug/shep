import { expect, test, type Page } from "@playwright/test";

async function openLauncher(page: Page, defaultAgentInterface: "chat" | "terminal") {
  await page.goto("/tests/design-preview/?agents=installed");
  await page.evaluate(async (value) => {
    const { useProjectSettingsStore } = await import("/src/stores/useProjectSettingsStore.ts");
    useProjectSettingsStore.setState(state => ({ settings: { ...state.settings, defaultAgentInterface: value } }));
  }, defaultAgentInterface);
  const claude = page.getByRole("button", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Chat & terminal");
  await claude.click();
}

const tip = (page: Page) => page.getByText("run agents as a chat, with tool calls and changes inline.");

test("terminal users see the chat tip until they dismiss it", async ({ page }) => {
  await openLauncher(page, "terminal");
  await expect(tip(page)).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(tip(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(tip(page)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss chat tip" }).click();
  await expect(tip(page)).toHaveCount(0);

  await openLauncher(page, "terminal");
  await expect(page.getByRole("button", { name: "Start Claude Code", exact: true })).toBeEnabled();
  await expect(tip(page)).toHaveCount(0);
});

test("chat users never see the chat tip", async ({ page }) => {
  await openLauncher(page, "chat");
  await expect(page.getByRole("button", { name: "Start Claude Code", exact: true })).toBeEnabled();
  await expect(tip(page)).toHaveCount(0);
});
