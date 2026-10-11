import { expect, test } from "@playwright/test";

test("chat model preferences persist safely across sessions", async ({ page }) => {
  await page.goto("/tests/chat-models/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 8 checks passed");
});
