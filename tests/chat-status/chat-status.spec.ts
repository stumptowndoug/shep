import { expect, test } from "@playwright/test";

test("ACP events drive two sidebar indicators in light and dark themes", async ({ page }) => {
  await page.goto("/tests/chat-status/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 22 checks passed", { timeout: 30_000 });
});
