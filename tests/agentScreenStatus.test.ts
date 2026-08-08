import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgentScreenStatus,
  resolveAgentStatusAuthority,
} from "../src/lib/agentScreenStatus.ts";
import { nextAgentDoneState } from "../src/lib/agentActivity.ts";

test("Claude visible confirmation is blocked", () => {
  const result = detectAgentScreenStatus(
    "claude",
    "Do you want to proceed?\n❯ 1. Yes\n  2. No\nesc to cancel · enter to confirm",
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "claude-live-form");
});

test("Claude working title is working", () => {
  const result = detectAgentScreenStatus("claude", "Implementing changes", "* shep");
  assert.equal(result.state, "working");
  assert.equal(result.ruleId, "claude-working-title");
});

test("Claude live prompt is idle", () => {
  const result = detectAgentScreenStatus("claude", "Done.\n\n❯ ");
  assert.equal(result.state, "idle");
  assert.equal(result.confidence, "explicit");
});

test("Claude transcript viewer preserves the previous state", () => {
  const result = detectAgentScreenStatus(
    "claude",
    "showing detailed transcript\nctrl+o to toggle\n↑↓ scroll",
  );
  assert.equal(result.state, null);
  assert.equal(result.confidence, "preserve");
});

test("Codex action-required title is blocked", () => {
  const result = detectAgentScreenStatus("codex", "", "Action Required | shep");
  assert.equal(result.state, "blocked");
});

test("Codex working row is working", () => {
  const result = detectAgentScreenStatus(
    "codex",
    "• Working (12s · esc to interrupt)",
  );
  assert.equal(result.state, "working");
  assert.equal(result.ruleId, "codex-working-row");
});

test("Codex stable title is explicit idle", () => {
  const result = detectAgentScreenStatus("codex", "› ", "Fix session history | shep");
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "codex-idle-title");
});

test("Antigravity permission UI is blocked", () => {
  const result = detectAgentScreenStatus(
    "antigravity",
    "Requesting permission for:\nrun cargo test\nDo you want to proceed?",
  );
  assert.equal(result.state, "blocked");
});

test("Antigravity spinner is working", () => {
  const result = detectAgentScreenStatus("antigravity", "⠋ Thinking about the change");
  assert.equal(result.state, "working");
});

test("OpenCode permission UI is blocked", () => {
  const result = detectAgentScreenStatus("opencode", "△ Permission required");
  assert.equal(result.state, "blocked");
});

test("OpenCode interrupt hint is working", () => {
  const result = detectAgentScreenStatus("opencode", "Updating files · esc to interrupt");
  assert.equal(result.state, "working");
});

test("Pi working literal is working", () => {
  const result = detectAgentScreenStatus("pi", "Working...");
  assert.equal(result.state, "working");
});

test("Known providers conservatively fall back to idle", () => {
  const result = detectAgentScreenStatus("antigravity", "ordinary transcript text");
  assert.equal(result.state, "idle");
  assert.equal(result.confidence, "fallback");
});

test("explicit screen evidence outranks provider state", () => {
  const screen = detectAgentScreenStatus("claude", "❯ ");
  const result = resolveAgentStatusAuthority(
    screen,
    200,
    { state: "working", updatedAt: 100 },
    true,
  );
  assert.equal(result?.state, "idle");
  assert.equal(result?.source, "screen");
});

test("provider state outranks an unmatched-screen fallback", () => {
  const screen = detectAgentScreenStatus("claude", "ordinary transcript text");
  const result = resolveAgentStatusAuthority(
    screen,
    200,
    { state: "working", updatedAt: 100 },
    true,
  );
  assert.equal(result?.state, "working");
  assert.equal(result?.source, "provider");
});

test("provider-only blocked state is not promoted without visible evidence", () => {
  const screen = detectAgentScreenStatus("claude", "ordinary transcript text");
  const result = resolveAgentStatusAuthority(
    screen,
    200,
    { state: "blocked", updatedAt: 100 },
    true,
  );
  assert.equal(result?.state, "idle");
  assert.equal(result?.source, "fallback");
});

test("transcript viewers preserve the previous effective state", () => {
  const screen = detectAgentScreenStatus(
    "claude",
    "showing detailed transcript\nctrl+o to toggle\n↑↓ scroll",
  );
  const result = resolveAgentStatusAuthority(
    screen,
    200,
    { state: "working", updatedAt: 100 },
    true,
  );
  assert.equal(result, null);
});

test("background working-to-idle transition becomes done", () => {
  assert.equal(nextAgentDoneState("working", false, "idle", false), true);
});

test("viewed working-to-idle transition remains idle", () => {
  assert.equal(nextAgentDoneState("working", false, "idle", true), false);
});

test("new work clears a previous done state", () => {
  assert.equal(nextAgentDoneState("idle", true, "working", false), false);
});

test("viewing a completed agent clears done", () => {
  assert.equal(nextAgentDoneState("idle", true, "idle", true), false);
});
