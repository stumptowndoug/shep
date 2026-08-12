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

test("Claude current permission prompt is blocked", () => {
  const result = detectAgentScreenStatus(
    "claude",
    "Bash command\nDo you want to proceed?\nEsc to cancel · Tab to amend · ctrl+e to explain",
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

test("Codex current command approval is blocked", () => {
  const result = detectAgentScreenStatus(
    "codex",
    "Would you like to run the following command?\nYes, proceed (y)\nPress enter to confirm or esc to cancel",
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "codex-live-blocker");
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

test("Cursor waiting title is blocked", () => {
  const result = detectAgentScreenStatus("cursor", "", "Fix tests - ❓ Waiting for you");
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "cursor-blocked-title");
});

test("Cursor working title is working", () => {
  const result = detectAgentScreenStatus("cursor", "", "Fix tests - ⌨️ Running shell command");
  assert.equal(result.state, "working");
  assert.equal(result.ruleId, "cursor-working-title");
});

test("Cursor ready title is idle", () => {
  const result = detectAgentScreenStatus("cursor", "", "Fix tests - ✅ Ready");
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "cursor-ready-title");
});

test("Antigravity permission UI is blocked", () => {
  const result = detectAgentScreenStatus(
    "antigravity",
    "Requesting permission for:\nrun cargo test\nDo you want to proceed?",
  );
  assert.equal(result.state, "blocked");
});

test("Antigravity spinner is working", () => {
  const result = detectAgentScreenStatus("antigravity", "⣾  Generating...\nesc to cancel");
  assert.equal(result.state, "working");
});

test("Antigravity question UI is blocked", () => {
  const result = detectAgentScreenStatus(
    "antigravity",
    "Question 1/1: What would you like to focus on next?\nOption one\n↑/↓ Navigate · enter Select · esc Skip",
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "antigravity-question");
});

test("Antigravity live prompt is explicit idle", () => {
  const result = detectAgentScreenStatus(
    "antigravity",
    ">\n? for shortcuts\nGemini 3.5 Flash · high",
  );
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "antigravity-live-prompt");
});

test("OpenCode permission UI is blocked", () => {
  const result = detectAgentScreenStatus("opencode", "△ Permission required");
  assert.equal(result.state, "blocked");
});

test("OpenCode interrupt hint is working", () => {
  const result = detectAgentScreenStatus("opencode", "Updating files · esc interrupt");
  assert.equal(result.state, "working");
});

test("OpenCode question UI is blocked", () => {
  const result = detectAgentScreenStatus(
    "opencode",
    "Choose a direction\n↑↓ select  enter submit  esc dismiss",
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "opencode-question");
});

test("OpenCode live prompt is explicit idle", () => {
  const result = detectAgentScreenStatus(
    "opencode",
    "Ask anything... \"Fix broken tests\"\ntab agents  ctrl+p commands\n~/dev/shep:main",
  );
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "opencode-live-prompt");
});

test("Pi working literal is working", () => {
  const result = detectAgentScreenStatus("pi", "⠋ Working...");
  assert.equal(result.state, "working");
});

test("Pi extension input is blocked", () => {
  const result = detectAgentScreenStatus(
    "pi",
    "What should the agent do next?\nenter submit  esc cancel\nMCP: 0/1 servers",
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.ruleId, "pi-extension-input");
});

test("Pi live prompt is explicit idle", () => {
  const result = detectAgentScreenStatus(
    "pi",
    "~/dev/shep (main)\ncontext 2% (auto)\nMCP: 0/1 servers",
  );
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "pi-live-prompt");
});

test("Pi model picker remains idle rather than looking blocked", () => {
  const result = detectAgentScreenStatus(
    "pi",
    "→ grok-4.5 [xai] ✓\nModel Name: Grok 4.5\n↑↓ navigate  enter select  esc cancel\nMCP: 0/1 servers",
  );
  assert.equal(result.state, "idle");
  assert.equal(result.ruleId, "pi-live-prompt");
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
