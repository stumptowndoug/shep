import test from "node:test";
import assert from "node:assert/strict";
import { isStopShortcut, recallStep, sentPrompts } from "../src/lib/acp/chatKeys.ts";

const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("Esc and Ctrl+C stop; copy and other chords do not", () => {
  assert.equal(isStopShortcut(key("Escape")), true);
  assert.equal(isStopShortcut(key("c", { ctrlKey: true })), true);
  assert.equal(isStopShortcut(key("C", { ctrlKey: true })), true);
  assert.equal(isStopShortcut(key("c", { metaKey: true })), false);
  assert.equal(isStopShortcut(key("c", { ctrlKey: true, altKey: true })), false);
  assert.equal(isStopShortcut(key("c")), false);
  assert.equal(isStopShortcut(key("Escape", { metaKey: true })), false);
});

test("sent prompts skip turns without a typed prompt", () => {
  assert.deepEqual(sentPrompts([{ prompt: "one" }, { prompt: null }, { prompt: "  " }, { prompt: "two" }]), ["one", "two"]);
});

test("recall steps back through prompts and forward to an empty box", () => {
  const prompts = ["first", "second", "third"];
  assert.deepEqual(recallStep(prompts, null, "older"), { index: 0, text: "third" });
  assert.deepEqual(recallStep(prompts, 0, "older"), { index: 1, text: "second" });
  assert.deepEqual(recallStep(prompts, 1, "older"), { index: 2, text: "first" });
  assert.equal(recallStep(prompts, 2, "older"), null);
  assert.deepEqual(recallStep(prompts, 2, "newer"), { index: 1, text: "second" });
  assert.deepEqual(recallStep(prompts, 1, "newer"), { index: 0, text: "third" });
  assert.deepEqual(recallStep(prompts, 0, "newer"), { index: null, text: "" });
  assert.equal(recallStep(prompts, null, "newer"), null);
  assert.equal(recallStep([], null, "older"), null);
});
