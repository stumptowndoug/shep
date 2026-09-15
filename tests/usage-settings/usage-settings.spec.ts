import { expect, test } from "@playwright/test";

test("utilization limits have independent accessible controls and safe defaults", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  const labels = [
    "Gemini · Antigravity weekly limit", "Gemini · Antigravity 5-hour limit",
    "Claude + GPT · Antigravity weekly limit", "Claude + GPT · Antigravity 5-hour limit",
    "Claude Code weekly limit", "Claude Code 5-hour limit",
  ];
  const defaults = [true, false, false, false, true, false];
  await expect(page.getByRole("checkbox")).toHaveCount(6);
  for (let i = 0; i < labels.length; i++) {
    await expect(page.getByRole("checkbox", { name: labels[i], exact: true })).toBeChecked({ checked: defaults[i] });
  }
  await page.screenshot({ path: testInfo.outputPath("usage-settings.png") });
  for (let i = 0; i < labels.length; i++) {
    await page.getByRole("checkbox", { name: labels[i], exact: true }).click();
    for (let j = 0; j < labels.length; j++) {
      await expect(page.getByRole("checkbox", { name: labels[j], exact: true })).toBeChecked({ checked: j <= i ? !defaults[j] : defaults[j] });
    }
  }
  await page.getByRole("button", { name: "Toggle saving" }).click();
  for (const label of labels) await expect(page.getByRole("checkbox", { name: label, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Hide Antigravity" }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(2);
});
