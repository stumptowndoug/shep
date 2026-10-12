import { expect, test } from "@playwright/test";

test("chat drafts and stop reasons survive session lifecycle changes", async ({ page }) => {
  await page.goto("/tests/chat-sessions/");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("status")).toHaveText("All 5 checks passed");
});
