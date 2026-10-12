import { expect, test } from "@playwright/test";

test("the launcher opens on the agent started last, with its options in one card", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("shep:last-agent", "codex"));
  await page.goto("/tests/design-preview/?agents=installed");
  await expect(page.getByRole("button", { name: "Codex", exact: true })).toHaveAttribute("aria-pressed", "true");
  const card = page.getByRole("region", { name: "Codex session" });
  await expect(card.getByRole("button", { name: "Start Codex", exact: true })).toBeEnabled();
  await expect(card.getByRole("group", { name: "Interface" })).toBeVisible();
  await expect(card.getByRole("group", { name: "Permissions" })).toBeVisible();

  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("region", { name: "Claude Code session" })).toBeVisible();
  // Picking the selected agent again keeps it; there is always one card.
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("the tab bar's + opens a menu that leads with New agent, then the project's other tabs", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed");
  const toggle = page.getByRole("button", { name: "New", exact: true });
  await toggle.click();
  const menu = page.getByRole("menu", { name: "Open in this project" });
  await expect(menu.getByRole("menuitem")).toHaveText([/New agent/, /Terminal/, /Commands/, /Changes/, /To-dos/, /Open in/, /Show in Finder/]);
  // The toggle closes its own menu instead of reopening it.
  await toggle.click();
  await expect(menu).toHaveCount(0);

  await toggle.click();
  await menu.getByRole("menuitem", { name: /Commands/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Open tab Commands" })).toBeVisible();
});

test("the sidebar's More button offers the same menu beside New agent", async ({ page }) => {
  await page.goto("/tests/design-preview/?agents=installed");
  await expect(page.locator(".side-nav--primary").getByRole("button", { name: /New agent/ })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menu", { name: "Open in this project" }).getByRole("menuitem", { name: /Changes/ }).click();
  await expect(page.getByRole("tab", { name: "Open tab Changes" })).toBeVisible();
});
