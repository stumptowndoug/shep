import { expect, test } from "@playwright/test";

test("agent images load local files, keep remote ones as links, and links open outside the app", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/useChatStore.ts");
    const text = [
      "![Updated website preview](/tmp/shots/preview.png)",
      "![Missing shot](./missing.png) ![Huge shot](/tmp/huge.png)",
      "![Remote](https://example.com/pixel.png)",
      "See [PR #32](https://github.com/example/repo/pull/32).",
    ].join("\n\n");
    useChatStore.getState().update(900, chat => ({ ...chat, status: "ready", turns: [{
      id: 0, prompt: "show it", startedAt: 1, endedAt: 2, stopReason: "end_turn",
      items: [{ kind: "message", id: "images", messageId: null, text }],
    }] }));
  });
  const chat = page.locator(".chat-view:visible .chat-markdown");

  const image = chat.locator("img.chat-image__img");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("alt", "Updated website preview");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  await image.click();
  await expect(page.locator("html")).toHaveAttribute("data-preview-last-revealed", "/tmp/shots/preview.png");

  await expect(chat.locator(".chat-image--failed", { hasText: "Missing shot" })).toContainText("Image not found");
  await expect(chat.locator(".chat-image--failed", { hasText: "Missing shot" }).getByRole("button", { name: "Open" })).toHaveCount(0);
  const huge = chat.locator(".chat-image--failed", { hasText: "Huge shot" });
  await expect(huge).toContainText("larger than 10 MB");
  await huge.getByRole("button", { name: "Open" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-preview-last-revealed", "/tmp/huge.png");

  const remote = chat.locator("a.chat-image--link");
  await expect(remote).toHaveText("Remote");
  await remote.click();
  await expect(page.locator("html")).toHaveAttribute("data-preview-last-opened-url", "https://example.com/pixel.png");

  await chat.getByRole("link", { name: "PR #32" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-preview-last-opened-url", "https://github.com/example/repo/pull/32");
  expect(page.url()).toContain("/tests/design-preview/");
});
