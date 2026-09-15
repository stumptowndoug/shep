import { expect, test } from "@playwright/test";

test("summaries reflect independent limits and keep unavailable providers blank", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  const claude = page.getByLabel("Edit Claude limits", { exact: true });
  await expect(claude).toContainText("Weekly");
  await expect(page.getByLabel("Edit Gemini limits", { exact: true })).toContainText("Weekly");
  await expect(page.getByLabel("Edit Claude + GPT limits", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("provider-codex").locator("summary")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("usage-settings.png") });
  for (const [label, weekly] of [["Claude", true], ["Gemini", true]] as const) {
    const summary = page.getByLabel(`Edit ${label} limits`, { exact: true });
    await summary.click();
    const fiveHour = page.getByRole("button", { name: `${label} 5-hour limit`, exact: true });
    const week = page.getByRole("button", { name: `${label} weekly limit`, exact: true });
    await expect(week).toHaveAttribute("aria-pressed", String(weekly));
    await expect(fiveHour).toHaveAttribute("aria-pressed", "false");
    await fiveHour.click();
    await expect(summary).toContainText(weekly ? "Weekly + 5h" : "5h");
    await week.click();
    await expect(summary).toContainText(weekly ? "5h" : "Weekly + 5h");
    await page.keyboard.press("Escape");
    await expect(summary).toBeFocused();
  }
  await page.getByRole("button", { name: "Toggle saving" }).click();
  await claude.click();
  await expect(page.getByRole("button", { name: "Claude weekly limit", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Hide Antigravity" }).click();
  await expect(page.locator("summary")).toHaveCount(1);
  await page.getByRole("button", { name: "Custom Claude budget" }).click();
  await expect(page.locator("summary")).toHaveCount(0);
});

test("picker supports keyboard editing, outside dismissal, and narrow layouts", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  const claude = page.getByLabel("Edit Claude limits", { exact: true });
  const gemini = page.getByLabel("Edit Gemini limits", { exact: true });
  const c = await claude.boundingBox(), g = await gemini.boundingBox();
  expect(c?.x).toBe(g?.x);
  await claude.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const weekly = page.getByRole("button", { name: "Claude weekly limit", exact: true });
  await expect(weekly).toBeFocused();
  await page.keyboard.press("Space");
  await expect(claude).toContainText("Hidden");
  await gemini.click();
  await expect(page.locator("details[open]")).toHaveCount(1);
  await page.getByRole("heading", { name: "Usage Providers" }).click();
  await expect(page.locator("details[open]")).toHaveCount(0);
  await page.setViewportSize({ width: 520, height: 800 });
  await gemini.click();
  await page.screenshot({ path: testInfo.outputPath("usage-settings-narrow.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("details[open]")).toHaveCount(0);
});
