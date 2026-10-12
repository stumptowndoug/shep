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
