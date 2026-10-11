import { expect, test } from "@playwright/test";
test("Cursor ACP supports auth, settings, permissions, questions, plans, cancellation and resume", async ({ page }) => {
  await page.goto("/tests/cursor-chat/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 13 checks passed");
});
