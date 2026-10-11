import { expect, test } from "@playwright/test";
test("Antigravity chat handles managed runtime, sign-in, lifecycle, and standard ACP", async ({ page }) => {
  await page.goto("/tests/antigravity-chat/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 9 checks passed");
});
