import { expect, test } from "@playwright/test";

test("streaming code uses plain markdown and highlights the final text only", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "working", turns: [{
      id: 0, prompt: "show code", startedAt: 1, endedAt: null, stopReason: null,
      items: [{ kind: "message", id: "stream", messageId: null, text: "```js\nconst value = 1;\n```" }],
    }] }));
  });
  await expect(page.locator(".chat-view:visible code")).toHaveText("const value = 1;\n");
  await expect(page.locator(".chat-view:visible .shiki")).toHaveCount(0);
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: chat.turns.map(turn => ({
      ...turn, endedAt: 2, stopReason: "end_turn", items: [{ kind: "message", id: "stream", messageId: null, text: "```js\nconst value = 2;\n```" }],
    })) }));
  });
  await expect(page.locator(".chat-view:visible .shiki")).toHaveCount(1);
  await expect(page.locator(".chat-view:visible code")).toContainText("const value = 2;");
});

test("large agent responses remain available without rich rendering", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({...chat,turns:chat.turns.map(turn=>({...turn,items:[{kind:"message",id:"large",messageId:null,text:"a@b.co\n".repeat(40_000)}]}))}));
  });
  const summary = page.getByText("Show large response as plain text (280,000 characters)");
  await expect(summary).toBeVisible();
  await expect(page.locator(".chat-markdown pre")).toBeHidden();
  await summary.click();
  await expect(page.locator(".chat-markdown pre")).toBeVisible();
  expect(await page.locator(".chat-markdown pre").textContent()).toHaveLength(280_000);
});

test("a finished reply with SQL, an unknown language, and a table renders instead of blanking the window", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  // Shaped like the PR-review reply that blanked the window: headings, SQL blocks, a table.
  const reply = [
    "## Proposed comment", "", "The join double-counts refunds:", "",
    "```sql", "SELECT o.id, SUM(r.amount) AS refunded", "FROM orders o", "JOIN refunds r ON r.order_id = o.id", "GROUP BY o.id;", "```", "",
    "| Check | Before | After |", "|---|---|---|", "| Rows | 1,204 | 1,198 |", "| Refunds | $9,410 | $8,772 |", "",
    "```kotlin", "val total = refunds.sumOf { it.amount }", "```", "",
    "```SQL", "select 1;", "```",
  ].join("\n");
  await page.evaluate(async (text) => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "give me your proposed comment", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "message", id: "review", messageId: null, text }],
    }] }));
  }, reply);
  const view = page.locator(".chat-view:visible");
  await expect(view.getByRole("heading", { name: "Proposed comment" })).toBeVisible();
  await expect(view.locator("table")).toContainText("Refunds");
  await expect(view.locator(".shiki")).toHaveCount(3);
  await expect(view.locator("pre.shiki code").first()).toContainText("SUM(r.amount)");
  await expect(view.locator("code")).toContainText(["val total = refunds.sumOf"]);
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
});

test("a rendering error shows a way back instead of a blank window", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    // Not a valid turn: items must be an array. The window must survive it.
    useChatStore.getState().update(900, chat => ({ ...chat, turns: [{ id: 0, prompt: "x", startedAt: 1, endedAt: 2, stopReason: "end_turn", items: null as never }] }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "Something went wrong." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload Shep" })).toBeVisible();
});

test("SQL dialects highlight at once and other languages load when a reply uses them", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  const reply = [
    "```postgres", "SELECT id FROM orders WHERE total > 100;", "```", "",
    "```kotlin", "fun main() { val total = 42 }", "```", "",
    "```cobol", "DISPLAY 'HELLO'.", "```",
  ].join("\n");
  await page.evaluate(async (text) => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "show me", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "message", id: "langs", messageId: null, text }],
    }] }));
  }, reply);
  const blocks = page.locator(".chat-view:visible pre.shiki");
  await expect(blocks).toHaveCount(3);
  // Highlighted blocks color their keywords differently from the rest of the line.
  const distinctColors = (index: number) => blocks.nth(index).evaluate((pre) =>
    new Set([...pre.querySelectorAll("span[style]")].map((span) => getComputedStyle(span).color)).size);
  await expect.poll(() => distinctColors(0)).toBeGreaterThan(1);
  await expect.poll(() => distinctColors(1)).toBeGreaterThan(1);
  // An unknown language is shown, uncolored, rather than breaking the reply.
  await expect(blocks.nth(2)).toContainText("DISPLAY 'HELLO'.");
  expect(await distinctColors(2)).toBeLessThanOrEqual(1);
});

test("an edit reported as a text diff shows colored lines and a change count", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    const output = [
      "edit_file: src/consts.ts", "edited", "changed lines: line 1",
      "--- original", "+++ updated", "@@", "-export const RELEASE_VERSION = '0.9.2';", "+export const RELEASE_VERSION = '0.10.1';",
    ].join("\n");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "bump it", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "tool", id: "edit", title: "edit_file: src/consts.ts", toolKind: "edit", status: "completed", output, diffs: [] }],
    }] }));
  });
  // A finished turn folds its tool calls under "Worked".
  await page.locator(".chat-view:visible .chat-worked > summary").click();
  const tool = page.locator(".chat-view:visible .chat-tool");
  await expect(tool.locator(".chat-tool__added")).toHaveText("+1");
  await expect(tool.locator(".chat-tool__removed")).toHaveText("−1");
  await tool.locator("summary").click();
  const added = tool.locator(".chat-diff-line--add");
  const removed = tool.locator(".chat-diff-line--remove");
  await expect(added).toContainText("0.10.1");
  await expect(removed).toContainText("0.9.2");
  const colors = await Promise.all([added, removed, tool.locator(".chat-diff-line--context").first()].map(line => line.evaluate(el => getComputedStyle(el).color)));
  expect(new Set(colors).size).toBe(3);
});
