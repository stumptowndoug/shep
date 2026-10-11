import { expect, test } from "@playwright/test";

test("a newer project refresh wins over an older response", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await expect(page.getByRole("button", {name:/Show changes: shep on/})).toBeVisible();
  const state = await page.evaluate(async () => {
    const { useRepoStore } = await import("/src/stores/useRepoStore.ts");
    const base = window.__TAURI_INTERNALS__.invoke;
    const repos = useRepoStore.getState().repos;
    const pending = [];
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => cmd === "list_repos"
      ? new Promise(resolve => pending.push(resolve)) : base(cmd, args, ...rest);
    const first = useRepoStore.getState().fetchRepos();
    const second = useRepoStore.getState().fetchRepos();
    pending[1](repos);
    await second;
    pending[0]([]);
    await first;
    return {count:useRepoStore.getState().repos.length,status:useRepoStore.getState().loadStatus};
  });
  expect(state.count).toBeGreaterThan(0);
  expect(state.status).toBe("ready");
});

test("slow project loading does not show first-run welcome", async ({ page }) => {
  await page.goto("/tests/design-preview/?repos=slow");
  await expect(page.getByRole("status").filter({hasText:"Loading projects"})).toBeVisible();
  await expect(page.getByRole("heading", {name:"Welcome to Shep."})).toHaveCount(0);
  await page.evaluate(() => window.releasePreviewRepos());
  await expect(page.getByRole("button", {name:/Show changes: shep on/})).toBeVisible();
});

test("failed project loading reports the error and can retry", async ({ page }) => {
  await page.goto("/tests/design-preview/?repos=error");
  await expect(page.getByRole("heading", {name:"Couldn’t load projects"})).toBeVisible();
  await expect(page.getByRole("heading", {name:"Welcome to Shep."})).toHaveCount(0);
  await page.getByRole("button", {name:"Retry",exact:true}).click();
  await expect(page.getByRole("button", {name:/Show changes: shep on/})).toBeVisible();
});

test("a successfully loaded empty installation shows welcome", async ({ page }) => {
  await page.goto("/tests/design-preview/?repos=empty");
  await expect(page.getByRole("heading", {name:"Welcome to Shep."})).toBeVisible();
});

test("temporary history storage remains visible until dismissed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tests/design-preview/?storage=error");
  const warning = page.getByText("History isn’t being saved", {exact:true});
  await expect(warning).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(warning).toBeVisible();
});
