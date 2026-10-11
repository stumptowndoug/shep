import { expect, test } from "@playwright/test";

test("model grouping preserves distinct names and every token in either order", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  const result = await page.evaluate(async () => {
    const { groupModels } = await import("/src/components/usage/usageLabels.ts");
    const labels = ["gpt-4", "gpt-4o", "Gemini 3.7 Fl", "Gemini 3.7 Flash", "Gemini 3.7 Flash (Low)", "unknown", "gpt-4o-2024-05-13"];
    const items = labels.map((label, i) => ({provider:"codex",label,tokens:(i+1)*10,tokensInput:(i+1)*10,tokensOutput:0,tokensCacheRead:0,tokensCacheWrite:0,tokensThoughts:0,sessions:null}));
    const summarize = rows => rows.map(row => [row.name, row.tokens]).sort((a,b) => a[0].localeCompare(b[0]));
    return {forward:summarize(groupModels(items)),reverse:summarize(groupModels([...items].reverse()))};
  });
  expect(result.forward).toEqual(result.reverse);
  expect(result.forward.reduce((sum, row) => sum + row[1], 0)).toBe(280);
  expect(result.forward).toContainEqual(["GPT-4", 10]);
  expect(result.forward).toContainEqual(["GPT-4o", 20]);
  expect(result.forward).toContainEqual(["Gemini 3.7 Fl", 30]);
  expect(result.forward).toContainEqual(["Gemini 3.7 Flash", 90]);
  expect(result.forward).toContainEqual(["Unspecified model", 60]);
});

test("usage failures are visible and retry loads the requested window", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await page.evaluate(() => {
    const base = window.__TAURI_INTERNALS__.invoke;
    let fail = true;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => {
      if (cmd === "get_usage_overview" && fail) { fail = false; return Promise.reject("Usage database unavailable"); }
      return base(cmd, args, ...rest);
    };
  });
  await page.getByRole("button", {name:"Usage",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Usage database unavailable");
  await expect(page.getByText("Loading usage…")).toHaveCount(0);
  await page.getByRole("button", {name:"Retry",exact:true}).click();
  await expect(page.locator(".usage-chart__col")).toHaveCount(24);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a late response cannot overwrite the current usage window", async ({ page }) => {
  await page.goto("/tests/design-preview/");
  await page.getByRole("button", {name:"Usage",exact:true}).click();
  await expect(page.locator(".usage-chart__col")).toHaveCount(24);
  await page.evaluate(() => {
    const base = window.__TAURI_INTERNALS__.invoke;
    window.finishUsageRequests = {};
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => cmd === "get_usage_overview"
      ? new Promise(resolve => { window.finishUsageRequests[args.window] = () => resolve(base(cmd, args, ...rest)); })
      : base(cmd, args, ...rest);
  });
  await page.getByRole("button", {name:"7d",exact:true}).click();
  await page.getByRole("button", {name:"30d",exact:true}).click();
  await page.waitForFunction(() => window.finishUsageRequests["7d"] && window.finishUsageRequests["30d"]);
  await page.evaluate(() => window.finishUsageRequests["30d"]());
  await expect(page.locator(".usage-chart__col")).toHaveCount(30);
  await page.evaluate(() => window.finishUsageRequests["7d"]());
  await expect(page.getByRole("button", {name:"30d",exact:true})).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".usage-chart__col")).toHaveCount(30);
});
