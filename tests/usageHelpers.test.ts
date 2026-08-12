import assert from "node:assert/strict";
import test from "node:test";

import { computePace, formatPercent, shouldShowUsageWindow } from "../src/components/usage/usageHelpers.ts";
import type { UsageWindowSnapshot } from "../src/lib/types.ts";

function usageWindow(
  window: string,
  usedPercent: number,
  resetAt: string,
): UsageWindowSnapshot {
  return {
    provider: "claude",
    windowId: `test-${window}`,
    window,
    label: window,
    scope: "plan",
    limit: 100,
    used: usedPercent,
    sourceType: "provider",
    confidence: "official",
    costKind: "included",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
    tokenTotal: null,
    paceStatus: null,
  };
}

test("positive sub-one utilization matches vendor display conventions", () => {
  assert.equal(formatPercent(0.020289), "1%");
  assert.equal(formatPercent(0), "0%");
});

test("Claude's 5h limit is opt-in while its other limits remain visible", () => {
  assert.equal(shouldShowUsageWindow("claude", "5h", false), false);
  assert.equal(shouldShowUsageWindow("claude", "5h", true), true);
  assert.equal(shouldShowUsageWindow("claude", "7d", false), true);
  assert.equal(shouldShowUsageWindow("codex", "5h", false), true);
});

test("24-hour provider windows compute pace from their own reset", () => {
  const reset = Date.parse("2026-08-13T00:00:00Z");
  const result = computePace(
    usageWindow("24h_pro", 80, new Date(reset).toISOString()),
    Date.parse("2026-08-12T12:00:00Z"),
  );
  assert.equal(result?.status, "over");
  assert.equal(result?.elapsedPct, 50);
});

test("monthly billing windows use the preceding calendar month", () => {
  const result = computePace(
    usageWindow("billing", 20, "2026-09-12T00:00:00Z"),
    Date.parse("2026-08-27T12:00:00Z"),
  );
  assert.equal(result?.status, "under");
  assert.equal(Math.round(result?.elapsedPct ?? 0), 50);
});
