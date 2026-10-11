import { expect, test } from "@playwright/test";

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
