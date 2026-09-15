import assert from "node:assert/strict";
import test from "node:test";

import { computePace, formatPercent, shouldShowUsageWindow, hasVisibleUsageLimits } from "../src/components/usage/usageHelpers.ts";
import { DEFAULT_USAGE_LIMITS } from "../src/lib/usageLimitSettings.ts";
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
  assert.equal(shouldShowUsageWindow("claude", "5h", DEFAULT_USAGE_LIMITS), false);
  assert.equal(shouldShowUsageWindow("claude", "5h", { ...DEFAULT_USAGE_LIMITS, showClaudeFiveHourLimit: true }), true);
  assert.equal(shouldShowUsageWindow("claude", "7d", DEFAULT_USAGE_LIMITS), true);
  assert.equal(shouldShowUsageWindow("codex", "5h", DEFAULT_USAGE_LIMITS), true);
});

test("each Antigravity pool and time window can be selected independently", () => {
  const entries = [
    ["antigravity-gemini-weekly", "showAntigravityGeminiWeeklyLimit", true],
    ["antigravity-gemini-5h", "showAntigravityGeminiFiveHourLimit", false],
    ["antigravity-3p-weekly", "showAntigravityClaudeWeeklyLimit", false],
    ["antigravity-3p-5h", "showAntigravityClaudeFiveHourLimit", false],
  ] as const;
  for (const [id, key, visible] of entries) {
    assert.equal(shouldShowUsageWindow("antigravity", "7d", DEFAULT_USAGE_LIMITS, id), visible);
    const settings = { ...DEFAULT_USAGE_LIMITS, [key]: !visible };
    for (const [otherId, otherKey, otherVisible] of entries) {
      assert.equal(shouldShowUsageWindow("antigravity", "7d", settings, otherId), otherKey === key ? !visible : otherVisible);
    }
  }
});

test("disabling every limit hides the provider; legacy pools follow family preferences", () => {
  assert.equal(hasVisibleUsageLimits("claude", { ...DEFAULT_USAGE_LIMITS, showClaudeWeeklyLimit: false }), false);
  assert.equal(hasVisibleUsageLimits("antigravity", { ...DEFAULT_USAGE_LIMITS, showAntigravityGeminiWeeklyLimit: false }), false);
  assert.equal(shouldShowUsageWindow("claude", "7d", { ...DEFAULT_USAGE_LIMITS, showClaudeWeeklyLimit: false }), false);
  assert.equal(shouldShowUsageWindow("antigravity", "24h_claude", DEFAULT_USAGE_LIMITS), false);
  assert.equal(shouldShowUsageWindow("antigravity", "24h_gemini_pro", DEFAULT_USAGE_LIMITS), true);
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
