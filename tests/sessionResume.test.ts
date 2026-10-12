import test from "node:test";
import assert from "node:assert/strict";
import { sessionResumeArgs, sessionResumeInterface, supportsSessionResume } from "../src/lib/sessionResume.ts";

test("recorded chat and terminal sessions use their original interface", () => {
  const both = { chat: true, terminal: true };
  assert.equal(sessionResumeInterface({ agentInterface: "chat" }, both), "chat");
  assert.equal(sessionResumeInterface({ agentInterface: "terminal" }, both), "terminal");
});
test("a missing runtime never resumes a known session in the wrong interface", () => {
  assert.equal(sessionResumeInterface({ agentInterface: "chat" }, { chat: false, terminal: true }), null);
  assert.equal(sessionResumeInterface({ agentInterface: "terminal" }, { chat: true, terminal: false }), null);
});
test("legacy history only resumes through its terminal runtime", () => {
  assert.equal(sessionResumeInterface({}, { chat: true, terminal: true }), "terminal");
  assert.equal(sessionResumeInterface({}, { chat: false, terminal: true }), "terminal");
  assert.equal(sessionResumeInterface({}, { chat: true, terminal: false }), null);
  assert.equal(sessionResumeInterface({}, { chat: false, terminal: false }), null);
});
test("Muse resumes a session by its UUID with the resume subcommand", () => {
  assert.equal(supportsSessionResume("muse"), true);
  assert.deepEqual(sessionResumeArgs("muse", "01a13150-c552-7f90-a112-275a03b297f4"), ["resume", "01a13150-c552-7f90-a112-275a03b297f4"]);
});
