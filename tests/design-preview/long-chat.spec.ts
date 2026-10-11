import { expect, test } from "@playwright/test";

test("long chats render recent turns and keep older content available on demand", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({...chat,turns:Array.from({length:200},(_,id)=>({
      id,prompt:`Prompt ${id}`,startedAt:1,endedAt:2,stopReason:"end_turn",
      items:[{kind:"tool",id:`tool-${id}`,title:"Read file",toolKind:"read",status:"completed",output:"details",diffs:[]},
        {kind:"message",id:`answer-${id}`,messageId:null,text:`Answer ${id}`}],
    }))}));
  });
  const chat = page.locator(".chat-view:visible");
  await expect(chat.locator(".chat-turn")).toHaveCount(50);
  await expect(page.getByText("Answer 199", {exact:true})).toBeVisible();
  await expect(chat.locator(".chat-worked__items")).toHaveCount(0);
  await page.getByRole("button", {name:"Show 50 earlier turns"}).click();
  await expect(chat.locator(".chat-turn")).toHaveCount(100);
  await chat.locator(".chat-worked summary").first().click();
  await expect(chat.locator(".chat-worked__items")).toHaveCount(1);
  await page.getByRole("button", {name:"Show recent turns"}).click();
  await expect(chat.locator(".chat-turn")).toHaveCount(50);
  expect(await page.evaluate(async () => (await import("/src/stores/useChatStore.ts")).useChatStore.getState().chats[900].turns.length)).toBe(200);
});
