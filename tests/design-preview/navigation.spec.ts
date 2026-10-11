import { expect, test } from "@playwright/test";
import groups from "../fixtures/navigation-groups.json" with { type: "json" };

test("the Rust group response shows pinned groups and survives refresh", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await page.evaluate(async (response) => {
    const { useRepoStore } = await import("/src/stores/useRepoStore.ts");
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) =>
      cmd === "list_groups" ? Promise.resolve(response) : base(cmd, args, ...rest);
    await useRepoStore.getState().fetchGroups();
  }, groups);
  await expect(page.locator(".project-group")).toHaveCount(1);
  await expect(page.locator(".project-group")).toContainText("Workspace");
  await page.evaluate(async () => {
    const { useRepoStore } = await import("/src/stores/useRepoStore.ts");
    await useRepoStore.getState().fetchGroups();
  });
  await expect(page.locator(".project-group")).toHaveCount(1);
});
