import { expect, test, type Page } from "@playwright/test";

const input = (page: Page) => page.getByRole("textbox", { name: "Message pi" });
const scroller = (page: Page) => page.locator(".chat-view__scroll");
const jump = (page: Page) => page.getByRole("button", { name: "Latest" });
const paragraphs = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `Paragraph ${from + i} of the answer.\n\n`).join("");

async function open(page: Page) {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/tests/chat-queue/");
  await expect(input(page)).toHaveAttribute("placeholder", "Ask pi anything");
}
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("");
}
async function stream(page: Page, text: string) {
  await page.evaluate(async text => (await import("/tests/chat-queue/harness.tsx")).stream(text), text);
}
async function update(page: Page, update: object) {
  await page.evaluate(async update => (await import("/tests/chat-queue/harness.tsx")).update(update), update);
}
async function finish(page: Page) {
  await page.evaluate(async () => (await import("/tests/chat-queue/harness.tsx")).finish());
}
const distanceFromEnd = (page: Page) => scroller(page).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
async function expectAtEnd(page: Page) {
  await expect.poll(() => distanceFromEnd(page)).toBeLessThan(2);
}
async function wheelUp(page: Page) {
  await scroller(page).hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(100);
}

test("streaming output stays in view until the user scrolls up, then holds still", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await expect(page.getByText("Paragraph 39 of the answer.")).toBeAttached();
  await expectAtEnd(page);
  await expect(jump(page)).toHaveCount(0);

  await wheelUp(page);
  await expect(jump(page)).toBeVisible();
  const top = await scroller(page).evaluate(el => el.scrollTop);
  await stream(page, paragraphs(20, 40));
  await expect(page.getByText("Paragraph 59 of the answer.")).toBeAttached();
  expect(await scroller(page).evaluate(el => el.scrollTop)).toBe(top);

  await jump(page).click();
  await expectAtEnd(page);
  await expect(jump(page)).toHaveCount(0);
  await stream(page, paragraphs(10, 60));
  await expect(page.getByText("Paragraph 69 of the answer.")).toBeAttached();
  await expectAtEnd(page);
});

test("a turn of thoughts and tool calls stays followed as each tool's output arrives", async ({ page }) => {
  await open(page);
  await send(page, "Work through the files");
  for (let step = 0; step < 20; step++) {
    await update(page, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Thinking about file ${step}.` } });
    await page.waitForTimeout(30);
    await update(page, { sessionUpdate: "tool_call", toolCallId: `read-${step}`, title: `Read src/file${step}.ts`, kind: "read", status: "in_progress" });
    await page.waitForTimeout(30);
    // A finished tool gains output, and with it something to expand.
    await update(page, { sessionUpdate: "tool_call_update", toolCallId: `read-${step}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "line\n".repeat(30) } }] });
    await page.waitForTimeout(30);
    await stream(page, `File ${step} looks fine.`);
    await page.waitForTimeout(30);
  }
  await expect(page.getByText("File 19 looks fine.")).toBeAttached();
  await expectAtEnd(page);
  await expect(jump(page)).toHaveCount(0);
});

test("a long answer after a few reads stays in view when the turn ends", async ({ page }) => {
  await open(page);
  await send(page, "Explain how a live turn renders");
  for (let step = 0; step < 3; step++) {
    await update(page, { sessionUpdate: "tool_call", toolCallId: `read-${step}`, title: "Read File", kind: "read", status: "pending" });
    await update(page, { sessionUpdate: "tool_call_update", toolCallId: `read-${step}`, status: "completed", title: `Read src/file${step}.ts`, content: [{ type: "content", content: { type: "text", text: "line\n".repeat(30) } }] });
  }
  await stream(page, paragraphs(30));
  await expectAtEnd(page);
  // Ending the turn folds the reads into "Worked" and rebuilds the answer.
  await finish(page);
  await expect(page.getByText("Worked", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await expectAtEnd(page);
  await expect(page.getByText("Paragraph 29 of the answer.")).toBeInViewport();
  await expect(jump(page)).toHaveCount(0);
});

test("a burst of text is revealed steadily, pinned to the very end, and finishes after the turn does", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await page.evaluate(() => {
    const el = document.querySelector(".chat-view__scroll")!;
    const w = window as unknown as { samples: { chars: number; gap: number }[] };
    w.samples = [];
    const tick = () => {
      w.samples.push({ chars: document.querySelector(".chat-turn > .chat-markdown")?.textContent?.length ?? 0, gap: el.scrollHeight - el.scrollTop - el.clientHeight });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Most of the reply in one go, and the turn ends while it's still being revealed.
  await stream(page, paragraphs(60));
  await expect(page.locator(".chat-turn > .chat-markdown")).toBeAttached();
  await finish(page);
  await expect(page.getByText("Paragraph 59 of the answer.")).toBeAttached();
  await page.waitForTimeout(100);
  const samples = await page.evaluate(() => (window as unknown as { samples: { chars: number; gap: number }[] }).samples);
  const growing = new Set(samples.map(sample => sample.chars)).size;
  expect(growing).toBeGreaterThan(20);
  await expectAtEnd(page);
});

test("the scroll position moving up on its own, with no input, doesn't stop following", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await expect(page.getByText("Paragraph 39 of the answer.")).toBeAttached();
  await expectAtEnd(page);
  // WebKit does this when rows near the end are swapped, after a bounce, and when the chat first becomes scrollable.
  await scroller(page).evaluate(el => { el.scrollTop = 0; });
  await expectAtEnd(page);
  await expect(jump(page)).toHaveCount(0);
  await stream(page, paragraphs(10, 40));
  await expect(page.getByText("Paragraph 49 of the answer.")).toBeAttached();
  await expectAtEnd(page);
});

test("finished blocks of a reply keep their DOM while it streams and when the turn ends", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, "First paragraph, already complete.\n\n```ts\nconst a = 1;\n```\n\nSecond para");
  const reply = page.locator(".chat-turn > .chat-markdown");
  await expect(reply).toContainText("Second para");
  const first = await reply.locator("p").first().elementHandle();
  await stream(page, "graph keeps growing.\n\n" + paragraphs(10));
  await expect(page.getByText("Paragraph 9 of the answer.")).toBeAttached();
  await finish(page);
  await expect(reply.locator("pre.shiki")).toBeVisible();
  await expect(reply).toHaveCount(1);
  expect(await reply.locator("p").first().evaluate((node, before) => node === before, first)).toBe(true);
});

test("a huge reply keeps its markdown while it streams, and turns plain only once finished", async ({ page }) => {
  await open(page);
  await send(page, "Write a huge answer");
  await stream(page, "A link: https://example.com\n\n" + "Lots of words in a long reply. ".repeat(3_400));
  const reply = page.locator(".chat-turn > .chat-markdown");
  await expect(reply.locator("a")).toHaveCount(1);
  await expect(reply.locator(".chat-markdown__plain")).toHaveCount(0);
  await finish(page);
  await expect(reply.locator(".chat-markdown__plain")).toBeVisible({ timeout: 15_000 });
  await expect(reply.locator("a")).toHaveCount(0);
  await expectAtEnd(page);
});

test("scrolling back down to the end resumes following", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await expect(page.getByText("Paragraph 39 of the answer.")).toBeAttached();
  await wheelUp(page);
  await page.mouse.wheel(0, 2000);
  await expect(jump(page)).toHaveCount(0);
  await stream(page, paragraphs(10, 40));
  await expect(page.getByText("Paragraph 49 of the answer.")).toBeAttached();
  await expectAtEnd(page);
});

test("sending a message returns to the end even after scrolling up", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await finish(page);
  await expect(page.getByText("Paragraph 39 of the answer.")).toBeAttached();
  await wheelUp(page);
  await send(page, "Now summarize it");
  await expect(jump(page)).toHaveCount(0);
  await expectAtEnd(page);
  await expect(page.locator(".chat-user").last()).toBeInViewport();
});

test("a taller composer keeps the newest output in view", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await expectAtEnd(page);
  await input(page).fill("one\ntwo\nthree\nfour\nfive\nsix");
  await expectAtEnd(page);
  await expect(page.getByText("Paragraph 39 of the answer.")).toBeInViewport();
});

test("arrow keys in the composer don't stop following", async ({ page }) => {
  await open(page);
  await send(page, "Write a long answer");
  await stream(page, paragraphs(40));
  await input(page).press("ArrowUp");
  await stream(page, paragraphs(10, 40));
  await expect(page.getByText("Paragraph 49 of the answer.")).toBeAttached();
  await expectAtEnd(page);
  await expect(jump(page)).toHaveCount(0);
});
