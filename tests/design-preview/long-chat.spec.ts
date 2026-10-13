import { expect, test } from "@playwright/test";

test("long chats retain older text and clearly mark trimmed tool details", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    const { trimOldTurnDetails } = await import("/src/lib/acp/chatModel.ts");
    useChatStore.getState().update(900, chat => trimOldTurnDetails({...chat,turns:Array.from({length:200},(_,id)=>({
      id,prompt:`Prompt ${id}`,startedAt:1,endedAt:2,stopReason:"end_turn",
      items:[{kind:"tool",id:`tool-${id}`,title:"Read file",toolKind:"read",status:"completed",output:"details",diffs:[]},
        {kind:"message",id:`answer-${id}`,messageId:null,text:`Answer ${id}`}],
    }))}));
  });
  const chat = page.locator(".chat-view:visible");
  await expect(chat.locator(".chat-turn")).toHaveCount(50);
  await expect(page.getByText("Answer 199", {exact:true})).toBeVisible();
  await expect(chat.locator(".chat-worked__items")).toHaveCount(0);
  // Reading back up stops following the newest output.
  await chat.locator(".chat-view__scroll").hover();
  await page.mouse.wheel(0, -100_000);
  await page.getByRole("button", {name:"Show 50 earlier turns"}).click();
  await expect(chat.locator(".chat-turn")).toHaveCount(100);
  await chat.locator(".chat-worked summary").first().click();
  await expect(chat.locator(".chat-worked__items")).toHaveCount(1);
  await chat.locator(".chat-worked__items .chat-tool summary").first().click();
  await expect(chat.getByText("Tool output and diffs trimmed from older history to reduce memory use.")).toBeVisible();
  await expect(chat.getByText("Answer 100", {exact:true})).toBeVisible();
  await page.getByRole("button", {name:"Show recent turns"}).click();
  await expect(chat.locator(".chat-turn")).toHaveCount(50);
  expect(await page.evaluate(async () => (await import("/src/stores/useChatStore.ts")).useChatStore.getState().chats[900].turns.length)).toBe(200);
});
