import { expect, test } from "@playwright/test";

test("chat font and text size come from Settings, and code uses the terminal font", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    window.localStorage.removeItem("shep:chat-appearance");
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "explain", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "message", id: "answer", messageId: null, text: "Run `pnpm test` first." }],
    }] }));
  });
  const view = page.locator(".chat-view:visible");
  const paragraph = view.locator(".chat-markdown p").first();
  const fontSize = (locator = paragraph) => locator.evaluate(el => getComputedStyle(el).fontSize);
  const fontFamily = (locator = paragraph) => locator.evaluate(el => getComputedStyle(el).fontFamily);

  await expect.poll(() => fontSize()).toBe("15px");
  await expect.poll(() => fontFamily(view.locator(".chat-markdown code"))).toContain("MesloLGS NF");
  const defaultWidth = await view.locator(".chat-view__content").evaluate(el => el.getBoundingClientRect().width);

  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/useUIStore.ts");
    useUIStore.getState().toggleSettings();
  });
  await page.getByRole("button", { name: "Chat & Terminal" }).click();
  const chatSection = page.locator(".settings-section", { has: page.getByRole("heading", { name: "Chat" }) });
  await chatSection.getByRole("button", { name: "18px" }).click();
  await chatSection.getByRole("button", { name: /System/ }).click();
  await expect(chatSection.locator(".font-picker-item")).toHaveCount(3);
  await chatSection.getByPlaceholder("Search installed fonts...").fill("geo");
  await chatSection.locator(".font-picker-item", { hasText: "Georgia" }).click();
  await expect(chatSection.getByRole("button", { name: "Georgia" })).toBeVisible();

  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("shep:chat-appearance") ?? "null"));
  expect(saved).toEqual({ fontFamily: "Georgia", loadFont: false, fontSize: 18 });

  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/useUIStore.ts");
    useUIStore.getState().toggleSettings();
  });
  await expect.poll(() => fontSize()).toBe("18px");
  expect(await fontFamily()).toMatch(/^"?Georgia"?,/);
  // The column grows with the text so lines keep their length (window permitting).
  const width = await view.locator(".chat-view__content").evaluate(el => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(defaultWidth);
  // Chrome outside the chat keeps its size.
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).fontSize)).toBe("13px");
});
