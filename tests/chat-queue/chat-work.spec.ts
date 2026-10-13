import { expect, test, type Page } from "@playwright/test";

const input = (page: Page) => page.getByRole("textbox", { name: "Message pi" });
const work = (page: Page) => page.locator(".chat-turn .chat-worked");
const harness = async (page: Page, name: "update" | "stream" | "finish", arg?: unknown) => {
  await page.evaluate(async ([name, arg]) => {
    const h = await import("/tests/chat-queue/harness.tsx");
    (h[name as "update"] as (value?: unknown) => void)(arg);
  }, [name, arg] as const);
};

async function startTurn(page: Page) {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/tests/chat-queue/");
  await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
  await input(page).fill("Check the tests");
  await input(page).press("Enter");
}

test("a running turn folds its thinking, tools, and narration into one live row", async ({ page }, testInfo) => {
  await startTurn(page);
  await harness(page, "update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Where are the tests?" } });
  await expect(work(page).locator("summary")).toHaveText("WorkingThinking");
  await expect(page.locator(".chat-working")).toHaveCount(0);

  await harness(page, "stream", "I'll look at the test folder first.");
  await harness(page, "update", { sessionUpdate: "tool_call", toolCallId: "read", title: "Read tests/chat.test.ts", kind: "read", status: "in_progress" });
  await expect(work(page).locator("summary")).toHaveText("Workingchat.test.ts1 step");
  await expect(page.locator(".chat-tool")).toHaveCount(0);
  await expect(page.getByText("I'll look at the test folder first.")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("live-folded.png") });

  // Opening it shows every row, and it stays open as the turn goes on.
  await work(page).locator("summary").click();
  await expect(page.locator(".chat-tool")).toHaveCount(2);
  await harness(page, "update", { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "test('works')" } }] });
  await harness(page, "update", { sessionUpdate: "tool_call", toolCallId: "run", title: "`pnpm test`", kind: "execute", status: "in_progress" });
  await expect(page.locator(".chat-tool")).toHaveCount(3);
  await expect(work(page).locator(".chat-worked__status")).toHaveText("pnpm test");
  await page.screenshot({ path: testInfo.outputPath("live-open.png") });
});

test("the answer stays below the row, and finishing only relabels it", async ({ page }, testInfo) => {
  await startTurn(page);
  await harness(page, "update", { sessionUpdate: "tool_call", toolCallId: "read", title: "Read src/a.ts", kind: "read", status: "completed" });
  await harness(page, "stream", "All 12 tests pass.");
  await expect(page.locator(".chat-turn > .chat-markdown")).toHaveText("All 12 tests pass.");
  const row = await work(page).elementHandle();

  await harness(page, "finish");
  await expect(work(page).locator("summary")).toContainText(/^Worked\d+s · 1 step$/);
  expect(await work(page).evaluate((node, before) => node === before, row)).toBe(true);
  await expect(page.locator(".chat-turn > .chat-markdown")).toHaveText("All 12 tests pass.");
  await page.screenshot({ path: testInfo.outputPath("finished.png") });
});

test("a turn with only an answer keeps the plain working line", async ({ page }) => {
  await startTurn(page);
  await expect(page.locator(".chat-working")).toBeVisible();
  await harness(page, "stream", "Short answer.");
  await expect(work(page)).toHaveCount(0);
  await expect(page.locator(".chat-working")).toBeVisible();
});
