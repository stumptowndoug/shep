import assert from "node:assert/strict";
import test from "node:test";
import { museSubscriptionUsage } from "../src/lib/acp/museUsage.ts";

const usage = {
  observedAtMs: 1791830000000,
  tier: "pro",
  window: { usedPercent: 38, resetsAtMs: 1791840000000, windowDurationMins: 300 },
  weekly: { usedPercent: 12, resetsAtMs: 1792300000000 },
};

test("Muse subscription readings are read from the adapter's usage metadata", () => {
  const update = { sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { museSubscriptionUsage: { source: "msp-host-observation", billing: false, usage } } };
  assert.deepEqual(museSubscriptionUsage(update), usage);
  assert.deepEqual(museSubscriptionUsage({ sessionUpdate: "session_info_update", _meta: { museSubscriptionUsage: { usage } } }), usage);
});

test("updates without a usable Muse reading are ignored", () => {
  assert.equal(museSubscriptionUsage({ sessionUpdate: "usage_update", used: 1, size: 2 }), null);
  assert.equal(museSubscriptionUsage({ _meta: { museSubscriptionUsage: { usage: null } } }), null);
  assert.equal(museSubscriptionUsage({ _meta: { museSubscriptionUsage: { usage: { tier: "pro" } } } }), null);
  assert.equal(museSubscriptionUsage(null), null);
});
