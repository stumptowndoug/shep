import { expect, test } from "@playwright/test";

test("5h and 7D buttons toggle independently beside Custom", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  await expect(page.locator("summary, input[type=checkbox]")).toHaveCount(0);
  await expect(page.getByTestId("provider-codex").getByRole("group")).toHaveCount(0);
  await expect(page.getByText("Claude + GPT")).toHaveCount(0);
  for (const [provider, label] of [["claude", "Claude"], ["antigravity", "Gemini"]]) {
    const row = page.getByTestId(`provider-${provider}`);
    const five = row.getByRole("button", { name: `${label} 5h limit`, exact: true });
    const week = row.getByRole("button", { name: `${label} 7D limit`, exact: true });
    await expect(five).toHaveAttribute("aria-pressed", "false");
    await expect(week).toHaveAttribute("aria-pressed", "true");
    const customBox = (await row.getByRole("button", { name: "Custom", exact: true }).boundingBox())!;
    const fiveBox = (await five.boundingBox())!;
    expect(fiveBox.y).toBe(customBox.y);
    expect(fiveBox.x - customBox.x - customBox.width).toBeLessThan(10);
    await five.click();
    await expect(five).toHaveAttribute("aria-pressed", "true");
    await expect(week).toHaveAttribute("aria-pressed", "true");
    await week.click();
    await expect(week).toHaveAttribute("aria-pressed", "false");
    await expect(five).toHaveAttribute("aria-pressed", "true");
  }
  await page.screenshot({ path: testInfo.outputPath("usage-settings.png") });
  await page.getByRole("button", { name: "Toggle saving" }).click();
  for (const button of await page.getByRole("group").getByRole("button").all()) await expect(button).toBeDisabled();
  await page.getByRole("button", { name: "Hide Antigravity" }).click();
  await expect(page.getByRole("group")).toHaveCount(1);
  await page.getByRole("button", { name: "Custom Claude budget" }).click();
  await expect(page.getByRole("group")).toHaveCount(0);
});

test("buttons support keyboard input and narrow layouts", async ({ page }, testInfo) => {
  await page.goto("/tests/usage-settings/");
  await page.setViewportSize({ width: 520, height: 800 });
  const five = page.getByRole("button", { name: "Claude 5h limit", exact: true });
  await five.focus();
  await page.keyboard.press("Space");
  await expect(five).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  const week = page.getByRole("button", { name: "Claude 7D limit", exact: true });
  await expect(week).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(week).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("usage-settings-narrow.png") });
});
