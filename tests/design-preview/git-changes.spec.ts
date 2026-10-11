import { expect, test } from "@playwright/test";

test("summary and panel share scans and coalesce changes during a slow scan", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await expect(page.getByRole("button", {name:/Show changes: shep on.*5 files/})).toBeVisible();
  await page.evaluate(() => {
    const base = window.__TAURI_INTERNALS__.invoke;
    window.gitScans = 0;
    window.finishGitScan = null;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => {
      if (cmd === "git_changes") {
        window.gitScans++;
        if (window.gitScans === 1) return new Promise(resolve => { window.finishGitScan = () => resolve(base(cmd, args, ...rest)); });
      }
      return base(cmd, args, ...rest);
    };
  });
  await page.getByRole("button", {name:/Show changes: shep on/}).click();
  await expect(page.locator(".changes__file")).toHaveCount(5);
  expect(await page.evaluate(() => window.gitScans)).toBe(0);
  await page.evaluate(async () => (await import("/src/hooks/useGitChanges.ts")).invalidateGitChanges("/preview/shep"));
  await page.waitForFunction(() => Boolean(window.finishGitScan));
  await page.evaluate(async () => {
    const { invalidateGitChanges } = await import("/src/hooks/useGitChanges.ts");
    for (let i=0; i<30; i++) invalidateGitChanges("/preview/shep");
    window.finishGitScan();
  });
  await expect.poll(() => page.evaluate(() => window.gitScans)).toBe(2);
});

test("oversized diffs keep the Changes panel usable", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await page.evaluate(() => {
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => cmd === "git_file_diff"
      ? Promise.reject("Diff is too large to preview. Open this file in your editor.") : base(cmd, args, ...rest);
  });
  await page.getByRole("button", {name:/Show changes: shep on/}).click();
  await expect(page.getByText("Diff is too large to preview. Open this file in your editor.")).toBeVisible();
  await expect(page.getByRole("button", {name:"Open src/App.tsx in VS Code",exact:true})).toHaveCount(1);
  await expect(page.locator(".changes__file")).toHaveCount(5);
});
