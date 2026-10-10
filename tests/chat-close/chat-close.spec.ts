import { expect, test } from "@playwright/test";

test("chat close stays immediate while native cleanup is delayed", async ({ page }) => {
  await page.goto("/tests/chat-close/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 5 checks passed");
});
