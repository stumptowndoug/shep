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
