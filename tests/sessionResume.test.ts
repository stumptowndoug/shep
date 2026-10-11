import test from "node:test";
import assert from "node:assert/strict";
import { sessionResumeInterface } from "../src/lib/sessionResume.ts";

test("recorded chat and terminal sessions override the current interface preference", () => {
  const both = { chat: true, terminal: true };
  assert.equal(sessionResumeInterface({ agentInterface: "chat" }, "terminal", both), "chat");
  assert.equal(sessionResumeInterface({ agentInterface: "terminal" }, "chat", both), "terminal");
});
test("a missing runtime never resumes a known session in the wrong interface", () => {
  assert.equal(sessionResumeInterface({ agentInterface: "chat" }, "terminal", { chat: false, terminal: true }), null);
  assert.equal(sessionResumeInterface({ agentInterface: "terminal" }, "chat", { chat: true, terminal: false }), null);
});
test("legacy history still uses the preferred available interface", () => {
  assert.equal(sessionResumeInterface({}, "chat", { chat: true, terminal: true }), "chat");
  assert.equal(sessionResumeInterface({}, "chat", { chat: false, terminal: true }), "terminal");
  assert.equal(sessionResumeInterface({}, "terminal", { chat: true, terminal: false }), "chat");
  assert.equal(sessionResumeInterface({}, "chat", { chat: false, terminal: false }), null);
});
