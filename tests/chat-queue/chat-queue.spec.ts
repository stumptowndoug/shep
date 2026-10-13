import { expect, test, type Page } from "@playwright/test";

const input = (page: Page) => page.getByRole("textbox", { name: "Message pi" });
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("");
}
const snapshot = (page: Page) => page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).snapshot());
async function action(page: Page, name: "finish" | "failPrompt" | "releaseStartup" | "failStartup" | "exitAgent" | "close") {
  await page.evaluate(async name => (await import("/tests/chat-queue/harness.tsx"))[name](), name);
}
const queued = (page: Page) => page.getByRole("group", { name: "Queued message", exact: true });
const unsent = (page: Page) => page.getByRole("group", { name: "Not sent message", exact: true });
async function open(page: Page, query = "") {
  await page.goto(`/tests/chat-queue/${query}`);
  await expect(input(page)).toBeVisible();
  if (!query.includes("startup=hold")) await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
}

test("queued messages stay visible and become one ordered turn without duplicates", async ({ page }) => {
  await open(page);
  await send(page, "Review the current changes");
  await send(page, "Also check keyboard navigation");
  await send(page, "Include the compact layout");
  await expect(queued(page).locator(".chat-user")).toHaveText(["Also check keyboard navigation", "Include the compact layout"]);
  await expect(page.getByRole("status")).toHaveText("2 queued");
  expect((await snapshot(page)).requests).toHaveLength(1);
  await action(page, "finish");
  await expect(queued(page)).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).requests).toEqual([
    [{ type: "text", text: "Review the current changes" }],
    [{ type: "text", text: "Also check keyboard navigation" }, { type: "text", text: "Include the compact layout" }],
  ]);
  await expect(page.locator(".chat-turn")).toHaveCount(2);
  await expect(page.locator(".chat-turn").last().locator(".chat-user")).toHaveText(["Also check keyboard navigation", "Include the compact layout"]);
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("Include the compact layout");
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("Also check keyboard navigation");
  await input(page).fill("");
  await send(page, "One more follow-up during the batch");
  await action(page, "finish");
  await expect.poll(async () => (await snapshot(page)).requests.length).toBe(3);
  await action(page, "finish");
  await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
  expect((await snapshot(page)).requests).toHaveLength(3);
});

for (const stop of ["button", "Escape", "Control+c"]) {
  test(`${stop} preserves queued text as Not sent in its original position`, async ({ page }) => {
    await open(page);
    await send(page, "Working on the original task");
    await send(page, "Keep this stopped message");
    await send(page, "And this second message");
    if (stop === "button") await page.getByRole("button", { name: "Stop response" }).click();
    else await input(page).press(stop);
    await expect(unsent(page).locator(".chat-user")).toHaveText(["Keep this stopped message", "And this second message"]);
    await expect(queued(page)).toHaveCount(0);
    await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
    expect((await snapshot(page)).requests).toHaveLength(1);
    await send(page, "Start a different task");
    await expect(page.locator(".chat-user")).toHaveText(["Working on the original task", "Keep this stopped message", "And this second message", "Start a different task"]);
    expect((await snapshot(page)).requests[1]).toEqual([{ type: "text", text: "Start a different task" }]);
  });
}

for (const completion of ["finish", "failPrompt"] as const) {
  test(`delayed Stop cannot restart the agent after ${completion}`, async ({ page }) => {
    await open(page, "?cancel=hold");
    await send(page, "First task");
    await send(page, "Queued before Stop");
    await page.getByRole("button", { name: "Stop response" }).click();
    await send(page, "Typed while stopping");
    await expect(unsent(page).locator(".chat-user")).toHaveText(["Queued before Stop", "Typed while stopping"]);
    await action(page, completion);
    await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
    await expect(page.getByText("Stopped.", { exact: true })).toBeVisible();
    expect((await snapshot(page)).requests).toHaveLength(1);
    await send(page, "Explicitly start again");
    await expect.poll(async () => (await snapshot(page)).requests.length).toBe(2);
  });
}

test("messages entered during startup are visible and sent together once ready", async ({ page }) => {
  await open(page, "?startup=hold");
  await send(page, "Start with the queue");
  await send(page, "Then consider its visibility");
  await expect(queued(page)).toHaveCount(2);
  expect((await snapshot(page)).requests).toHaveLength(0);
  await action(page, "releaseStartup");
  await expect.poll(async () => (await snapshot(page)).requests).toEqual([[
    { type: "text", text: "Start with the queue" }, { type: "text", text: "Then consider its visibility" },
  ]]);
  await expect(queued(page)).toHaveCount(0);
  await expect(page.locator(".chat-turn .chat-user")).toHaveCount(2);
});

test("startup failure and process exit retain queued messages as Not sent", async ({ page }) => {
  await open(page, "?startup=hold");
  await send(page, "Do not lose this startup message");
  await action(page, "failStartup");
  await expect(input(page)).toBeDisabled();
  await expect(unsent(page)).toContainText("Do not lose this startup message");
  await expect(queued(page)).toHaveCount(0);
  expect((await snapshot(page)).requests).toHaveLength(0);
  await open(page);
  await send(page, "Working");
  await send(page, "Do not lose this follow-up");
  await action(page, "exitAgent");
  await expect(input(page)).toBeDisabled();
  await expect(unsent(page)).toContainText("Do not lose this follow-up");
  await expect(queued(page)).toHaveCount(0);
  expect((await snapshot(page)).requests).toHaveLength(1);
});

test("provider cancellation retains the queue and a recoverable error follows Springroll's next-turn behavior", async ({ page }) => {
  await open(page);
  await send(page, "Working");
  await send(page, "Cancelled by provider");
  await page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).finish("cancelled"));
  await expect(unsent(page)).toContainText("Cancelled by provider");
  expect((await snapshot(page)).requests).toHaveLength(1);
  await send(page, "Try again");
  await send(page, "Follow-up after an error");
  await action(page, "failPrompt");
  await expect(page.getByText("Simulated provider failure", { exact: true })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).requests.length).toBe(3);
  expect((await snapshot(page)).requests[2]).toEqual([{ type: "text", text: "Follow-up after an error" }]);
});

test("closing a working chat never dispatches queued follow-ups after a late completion", async ({ page }) => {
  await open(page);
  await send(page, "Working");
  await send(page, "Should never run");
  await action(page, "close");
  await action(page, "finish");
  await expect(input(page)).toHaveCount(0);
  const result = await snapshot(page);
  expect(result.chat).toBeUndefined();
  expect(result.requests).toHaveLength(1);
});

for (const theme of ["catppuccin", "github-light"]) {
  test(`${theme} wraps long queued text inside a compact chat`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await open(page, `?theme=${theme}`);
    await send(page, "Review the message queue");
    const text = "Also check the compact layout.\nKeep this literal: <script>alert('no')</script>\n" + "long-path/".repeat(35);
    await send(page, text);
    await expect(queued(page).locator(".chat-user")).toHaveText(text);
    await expect(queued(page).locator("script")).toHaveCount(0);
    await expect(queued(page).getByText("Queued", { exact: true })).toBeInViewport();
    const widths = await page.locator(".chat-view__scroll").evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await page.screenshot({ path: testInfo.outputPath(`queue-${theme}.png`) });
    await page.getByRole("button", { name: "Stop response" }).click();
    await expect(unsent(page).getByText("Not sent", { exact: true })).toBeVisible();
  });
}

test("a queued message can be taken back to edit, or removed, before it's sent", async ({ page }) => {
  await open(page);
  await send(page, "Start the review");
  await send(page, "Check the tests too");
  await send(page, "And the docs");
  await expect(queued(page)).toHaveCount(2);

  await queued(page).first().hover();
  await queued(page).first().getByRole("button", { name: "Edit" }).click();
  await expect(input(page)).toHaveValue("Check the tests too");
  await expect(input(page)).toBeFocused();
  await expect(queued(page).locator(".chat-user")).toHaveText(["And the docs"]);

  await queued(page).first().hover();
  await queued(page).first().getByRole("button", { name: "Remove" }).click();
  await expect(queued(page)).toHaveCount(0);

  await input(page).fill("Check the tests and the lint");
  await input(page).press("Enter");
  await action(page, "finish");
  const { requests } = await snapshot(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual([{ type: "text", text: "Check the tests and the lint" }]);
});

test("editing a queued message keeps what's already in the composer", async ({ page }) => {
  await open(page);
  await send(page, "Start");
  await send(page, "Queued thought");
  await input(page).fill("Half-written");
  await queued(page).hover();
  await queued(page).getByRole("button", { name: "Edit" }).click();
  await expect(input(page)).toHaveValue("Half-written\nQueued thought");
});
