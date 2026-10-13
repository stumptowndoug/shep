import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.goto("/tests/chat-workers/"); });

test("workers remain visible and active after the parent completes, with separate transcripts", async ({ page }) => {
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await page.getByRole("button", { name: "Delegate", exact: true }).click();
  await page.getByRole("button", { name: "Finish parent", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · working");
  const workers = page.locator(".chat-turn .chat-agents");
  await expect(workers.locator("summary")).toHaveText("2 agents2 running");
  await expect(page.locator(".chat-view__content .chat-markdown", { hasText: "Reviewing cancellation" })).toHaveCount(0);
  await workers.getByRole("button", { name: /^Reviewer, Running/ }).click();
  const peek = page.getByRole("complementary", { name: "Reviewer agent" });
  await expect(peek.getByLabel("Reviewer transcript")).toContainText("Reviewing cancellation behavior.");
  await expect(peek.getByLabel("Reviewer transcript")).not.toContainText("Checking the queue tests.");
  await expect(peek).toContainText("started by Claude Code");
  await page.getByRole("button", { name: "Spawn nested" }).click();
  await workers.getByRole("button", { name: /^Nested agent, Running/ }).click();
  await expect(page.getByRole("complementary", { name: "Nested agent agent" })).toContainText("started by Reviewer");
  await page.getByRole("button", { name: "Finish reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Finish tests", exact: true }).click();
  await expect(workers.locator("summary")).toHaveText("3 agents1 running · 2 done");
  await expect(page.getByTestId("state")).toHaveText("ready · working");
  await page.getByRole("button", { name: "Exit adapter" }).click();
  await expect(workers.getByRole("button", { name: /^Reviewer, Done/ })).toBeVisible();
  await expect(workers.getByRole("button", { name: /^Nested agent, Status unknown/ })).toBeVisible();
});

test("child approvals survive parent completion and remain answerable between turns", async ({ page }) => {
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await page.getByRole("button", { name: "Delegate", exact: true }).click();
  await page.getByRole("button", { name: "Child permission", exact: true }).click();
  await page.getByRole("button", { name: "Finish parent", exact: true }).click();
  await expect(page.locator(".chat-approval")).toContainText("Reviewer: Run checks");
  await expect(page.getByTestId("state")).toHaveText("ready · blocked");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.locator(".chat-approval")).toHaveCount(0);
  await page.getByRole("button", { name: "Child permission", exact: true }).click();
  await expect(page.locator(".chat-approval")).toBeVisible();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await page.getByRole("button", { name: "Finish reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Finish tests", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await page.getByRole("button", { name: "Inspect replies", exact: true }).click();
  const writes = JSON.parse(await page.getByTestId("replies").textContent() || "[]");
  expect(writes.filter((entry: {result?: {outcome?: {optionId?: string}}}) => entry.result?.outcome?.optionId === "allow")).toHaveLength(2);
  expect(writes[0].params.clientCapabilities._meta.jetbrains.air.capabilities).toEqual(["nativeSubagentSessions"]);
});

test("resumed child history does not appear as active work", async ({ page }) => {
  await page.getByRole("button", { name: "Resume chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  const workers = page.locator(".chat-agents");
  await workers.locator("summary").click();
  await workers.getByRole("button", { name: /^Reviewer, Done/ }).click();
  await expect(page.getByLabel("Reviewer transcript")).toContainText("Restored child result");
  await expect(page.getByRole("button", { name: "Copy result" })).toBeVisible();
  await expect(page.locator(".chat-view__content")).not.toContainText("Restored child result");
});

test("cancelling the parent waits for confirmed child outcomes", async ({ page }) => {
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await page.getByRole("button", { name: "Delegate", exact: true }).click();
  await page.getByRole("button", { name: "Cancel parent", exact: true }).click();
  await page.getByRole("button", { name: "Finish parent", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · working");
  const input = page.getByRole("textbox", { name: "Message Claude Code" });
  await input.fill("Typed while children are stopping");
  await input.press("Enter");
  await expect(page.getByRole("group", { name: "Not sent message", exact: true })).toContainText("Typed while children are stopping");
  await page.getByRole("button", { name: "Inspect replies", exact: true }).click();
  const writes = JSON.parse(await page.getByTestId("replies").textContent() || "[]");
  expect(writes.filter((entry: {method?: string}) => entry.method === "session/prompt")).toHaveLength(1);
  await page.getByRole("button", { name: "Finish reviewer", exact: true }).click();
  await expect(page.locator(".chat-agents summary")).toHaveText("2 agents1 running · 1 done");
  await page.getByRole("button", { name: "Finish tests", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await input.fill("Explicitly start again");
  await input.press("Enter");
  await expect(page.getByTestId("state")).toHaveText("working · working");
});

test("resume fallback routes early updates to the fresh session", async ({ page }) => {
  await page.goto("/tests/chat-workers/?cannotResume");
  await page.getByRole("button", { name: "Resume chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · working");
  await page.locator(".chat-agents").getByRole("button", { name: /^Reviewer, Running/ }).click();
  await expect(page.getByLabel("Reviewer transcript")).toContainText("New session child");
  await expect(page.locator(".chat-view__content .chat-markdown", { hasText: "New session child" })).toHaveCount(0);
});

test("worker controls are keyboard accessible and fit a narrow light window", async ({ page }) => {
  await page.setViewportSize({width: 520, height: 800});
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByTestId("state")).toHaveText("ready · idle");
  await page.getByRole("button", { name: "Delegate", exact: true }).click();
  await page.getByRole("button", { name: "Light theme" }).click();
  const row = page.getByRole("button", {name: /^Reviewer, Running/});
  await row.focus(); await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-pressed", "true");
  const peek = page.getByRole("complementary", { name: "Reviewer agent" });
  await expect(peek.getByLabel("Reviewer transcript")).toBeVisible();
  // Narrow windows: the peek covers the chat rather than squeezing it.
  expect(await peek.evaluate(node => getComputedStyle(node).position)).toBe("absolute");
  expect(await peek.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  // Escape closes the peek without stopping the chat's agent.
  await peek.getByRole("button", { name: "Close agent" }).focus();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect(page.getByTestId("state")).toHaveText("working · working");
  await page.screenshot({path: test.info().outputPath("workers-light.png")});
});
