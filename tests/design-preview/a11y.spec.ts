import { expect, test } from "@playwright/test";

test("the switcher keeps keyboard focus and restores it on Escape", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  const composer = page.locator("textarea").first();
  await composer.focus();
  await page.evaluate(async () => (await import("/src/stores/useUIStore.ts")).useUIStore.getState().setProjectSwitcherOpen(true));
  const search = page.getByRole("combobox", {name:"Search projects"});
  await expect(search).toBeFocused();
  await search.press("Tab");
  await expect(search).toBeFocused();
  await search.press("Shift+Tab");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(page.getByRole("dialog", {name:"Switch project"})).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test("sidebar project menus open from the keyboard and restore focus", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  const row = page.locator(".project-row").filter({hasText:"shep"}).first();
  await row.focus();
  await row.press("Shift+F10");
  await expect(page.getByRole("menu", {name:"Context menu"})).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("Escape in a Select closes only that popover", async ({ page }) => {
  await page.goto("/tests/design-preview/?view=chat");
  await page.evaluate(() => {
    window.escapedOutsideSelect = false;
    document.addEventListener("keydown", event => { if (event.key === "Escape") window.escapedOutsideSelect = true; });
  });
  const trigger = page.locator(".select__trigger").first();
  await trigger.click();
  await expect(page.locator(".select__popover")).toBeVisible();
  await trigger.press("Escape");
  await expect(page.locator(".select__popover")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.escapedOutsideSelect)).toBe(false);
});
