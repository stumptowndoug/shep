import { expect, test } from "@playwright/test";

test("code blocks and finished answers copy their text", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  await page.goto("/tests/design-preview/?view=chat");
  const answer = "Run this:\n\n```sh\npnpm test:chat\n```\n\nThen **commit**.";
  await page.evaluate(async (text) => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "how do I test chat?", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "message", id: "m", messageId: null, text }],
    }] }));
  }, answer);
  const copied = () => page.evaluate(() => (window as unknown as { copied?: string }).copied);
  const turn = page.locator(".chat-view:visible .chat-turn");

  const code = turn.getByRole("button", { name: "Copy code" });
  await turn.locator(".chat-code").hover();
  await code.click();
  await expect.poll(copied).toBe("pnpm test:chat");
  await expect(code).toHaveText("Copied");

  await turn.hover();
  await turn.getByRole("button", { name: "Copy response" }).click();
  await expect.poll(copied).toBe(answer);
  await expect(turn.getByRole("button", { name: "Copied" })).toBeVisible();
});
