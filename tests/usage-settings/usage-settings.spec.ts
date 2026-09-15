import { expect, test } from "@playwright/test";

test("utilization limits have independent accessible controls and safe defaults", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  const labels = [
    "Gemini weekly limit", "Gemini 5-hour limit",
    "Claude + GPT weekly limit", "Claude + GPT 5-hour limit",
    "Claude weekly limit", "Claude 5-hour limit",
  ];
  const defaults = [true, false, false, false, true, false];
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator(".usage-limit-toggle")).toHaveCount(6);
  await expect(page.getByTestId("provider-codex").locator(".usage-limit-toggle")).toHaveCount(0);
  for (let i = 0; i < labels.length; i++) {
    await expect(page.getByRole("button", { name: labels[i], exact: true })).toHaveAttribute("aria-pressed", String(defaults[i]));
  }
  await page.screenshot({ path: testInfo.outputPath("usage-settings.png") });
  for (let i = 0; i < labels.length; i++) {
    await page.getByRole("button", { name: labels[i], exact: true }).click();
    for (let j = 0; j < labels.length; j++) {
      await expect(page.getByRole("button", { name: labels[j], exact: true })).toHaveAttribute("aria-pressed", String(j <= i ? !defaults[j] : defaults[j]));
    }
  }
  await page.getByRole("button", { name: "Toggle saving" }).click();
  for (const label of labels) await expect(page.getByRole("button", { name: label, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Hide Antigravity" }).click();
  await expect(page.locator(".usage-limit-toggle")).toHaveCount(2);
  await page.getByRole("button", { name: "Custom Claude budget" }).click();
  await expect(page.locator(".usage-limit-toggle")).toHaveCount(0);
});

test("limit buttons stay right aligned and wrap without overflow", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  const claude = await page.getByRole("button", { name: "Claude 5-hour limit", exact: true }).boundingBox();
  const gemini = await page.getByRole("button", { name: "Gemini 5-hour limit", exact: true }).boundingBox();
  expect(claude?.x).toBe(gemini?.x);
  await page.setViewportSize({ width: 520, height: 800 });
  await page.screenshot({ path: testInfo.outputPath("usage-settings-narrow.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Claude weekly limit", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Claude weekly limit", exact: true })).toHaveAttribute("aria-pressed", "false");
});
