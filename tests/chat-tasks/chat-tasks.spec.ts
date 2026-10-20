import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.goto("/tests/chat-tasks/"); });

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready");
}

async function inspect(page: Page) {
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  return JSON.parse(await page.getByTestId("replies").textContent() || "{}");
}

test("a backgrounded command is one row with its file output and Stop", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Start server" }).click();
  await page.getByRole("button", { name: "Finish turn" }).click();
  await expect(page.getByTestId("state")).toHaveText("ready", { timeout: 5000 });

  const row = page.getByRole("button", { name: /^pnpm dev, In background/ });
  await expect(row).toBeVisible();
  // The call that started it says where the command went instead of looking finished.
  await page.locator(".chat-worked summary").first().click();
  await expect(page.locator(".chat-tool", { hasText: "pnpm dev" })).toContainText("in background");

  await row.click();
  const pane = page.getByRole("complementary", { name: "pnpm dev background command" });
  await expect(pane.getByLabel("Command output")).toContainText("server listening on :5173");
  await page.getByRole("button", { name: "More server output" }).click();
  await expect(pane.getByLabel("Command output")).toContainText("GET / 200", { timeout: 5000 });

  await pane.getByRole("button", { name: "Stop pnpm dev" }).click();
  await expect(page.getByRole("button", { name: /^pnpm dev, Stopped/ })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Stop pnpm dev" })).toHaveCount(0);
  const { writes, outputReads } = await inspect(page);
  expect(writes.find((entry: { method?: string }) => entry.method === "_session/async_task/stop").params)
    .toEqual({ sessionId: "root", asyncTaskId: "task-dev" });
  expect(outputReads[0]).toBe("/tmp/claude-501/tasks/task-dev.output");
  expect(writes[0].params.clientCapabilities._meta.terminal_output_delta).toBe(true);
});

test("streamed command output shows in its row's pane, and settles when the agent goes away", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Start watcher" }).click();
  await page.getByRole("button", { name: "Finish turn" }).click();
  await page.getByRole("button", { name: /^cargo watch, In background/ }).click();
  const pane = page.getByRole("complementary", { name: "cargo watch background command" });
  await expect(pane.getByLabel("Command output")).toContainText("Compiling shep\nFinished dev");
  await page.getByRole("button", { name: "Exit adapter" }).click();
  await expect(page.getByRole("button", { name: /^cargo watch, Status unknown/ })).toBeVisible();
  await expect(pane).toContainText("The agent stopped without reporting how this ended.");
});

test("a running command scrolled out of view gets a jump shortcut above the composer", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Start server" }).click();
  await page.getByRole("button", { name: "Finish turn" }).click();
  const jump = page.locator(".chat-background-jump");
  await expect(page.getByRole("button", { name: /^pnpm dev, In background/ })).toBeInViewport();
  await expect(jump).toHaveCount(0);

  await page.getByRole("button", { name: "Long answer" }).click();
  await expect(jump).toContainText("1 running command");
  await jump.click();
  await expect(page.getByRole("button", { name: /^pnpm dev, In background/ })).toBeInViewport();
  await expect(jump).toHaveCount(0);

  await page.getByRole("button", { name: /^pnpm dev, In background/ }).click();
  await page.getByRole("complementary", { name: "pnpm dev background command" }).getByRole("button", { name: "Stop pnpm dev" }).click();
  await page.locator(".chat-jump").click();
  await expect(jump).toHaveCount(0, { timeout: 2000 });
});
