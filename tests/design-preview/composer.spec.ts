import { expect, test } from "@playwright/test";

const composer = (page: import("@playwright/test").Page) => page.locator(".chat-composer:visible").last();

test("the composer shows the model and one gear for every other setting", async ({ page }) => {
  await page.goto("/tests/design-preview/?chat=1");
  const box = composer(page);
  await expect(box.locator(".chat-composer__controls > *")).toHaveCount(2);
  await expect(box.getByRole("button", { name: /^Reasoning/ })).toHaveCount(0);
  await expect(box.getByRole("button", { name: /^(Access|Mode):/ })).toHaveCount(0);

  const gear = box.getByRole("button", { name: "Chat settings" });
  await expect(gear).toHaveAttribute("title", /Reasoning/);
  await gear.click();
  const menu = page.getByRole("dialog", { name: "Chat settings" });
  await expect(menu.getByRole("group", { name: "Reasoning" }).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
  await expect(menu.getByRole("group", { name: "Access" }).getByRole("button", { name: "Full access" })).toHaveAttribute("aria-pressed", "true");
  await menu.getByRole("group", { name: "Reasoning" }).getByRole("button", { name: "Low" }).click();
  await expect(menu).toHaveCount(0);
  await expect(gear).toBeFocused();

  await gear.click();
  await expect(menu.getByRole("group", { name: "Reasoning" }).getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("Ask first marks the gear", async ({ page }) => {
  await page.goto("/tests/design-preview/?chat=1&access=ask");
  const gear = composer(page).getByRole("button", { name: "Chat settings" });
  await expect(gear).toHaveAttribute("title", /\(Ask first\)/);
  await expect(gear.locator(".chat-settings__ask")).toHaveCount(1);
});

test("access fixed at the start of a chat is shown, not offered", async ({ page }) => {
  await page.goto("/tests/design-preview/?chat=pi");
  await composer(page).getByRole("button", { name: "Chat settings" }).click();
  const access = page.getByRole("dialog", { name: "Chat settings" }).getByRole("group", { name: "Access" });
  await expect(access).toContainText("Full access");
  await expect(access).toContainText("Start a new chat to change this.");
  await expect(access.getByRole("button")).toHaveCount(0);
});
