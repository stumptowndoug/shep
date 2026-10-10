import assert from "node:assert/strict";
import test from "node:test";

import {
  addPermission,
  applySessionUpdate,
  emptyChat,
  endTurn,
  optionsFromSession,
  pendingPermission,
  resolvePermission,
  startTurn,
} from "../src/lib/acp/chatModel.ts";

// Abridged from a real `opencode acp` turn.
const OPENCODE_TURN = [
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "I'll read the package" } },
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: ".json file." } },
  { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", kind: "read", status: "pending", locations: [], rawInput: {} },
  {
    sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", kind: "read", title: "read",
    locations: [{ path: "/repo/package.json" }], rawInput: { filePath: "/repo/package.json" },
  },
  {
    sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", title: "package.json",
    content: [{ type: "content", content: { type: "text", text: "{ \"version\": \"0.8.4\" }" } }],
  },
  { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "The app version is 0" } },
  { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: ".8.4." } },
  { sessionUpdate: "usage_update", used: 12643, size: 200000 },
];

test("folds streamed chunks and tool updates into one turn", () => {
  let chat = startTurn(emptyChat(), "What version is this?");
  for (const update of OPENCODE_TURN) chat = applySessionUpdate(chat, update);
  chat = endTurn(chat, "end_turn");

  const [turn] = chat.turns;
  assert.equal(turn.stopReason, "end_turn");
  assert.deepEqual(turn.items.map((item) => item.kind), ["message", "tool", "message"]);
  assert.equal(turn.items[0].kind === "message" && turn.items[0].text, "I'll read the package.json file.");

  const tool = turn.items[1];
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") return;
  assert.equal(tool.title, "package.json");
  assert.equal(tool.status, "completed");
  assert.match(tool.output, /0\.8\.4/);
  assert.deepEqual(chat.usage, { used: 12643, size: 200000 });
});

test("generic tool titles fall back to the target path", () => {
  let chat = startTurn(emptyChat(), "x");
  chat = applySessionUpdate(chat, OPENCODE_TURN[2]);
  chat = applySessionUpdate(chat, OPENCODE_TURN[3]);
  const tool = chat.turns[0].items[0];
  assert.equal(tool.kind === "tool" && tool.title, "package.json");
});

test("message chunks with different ids stay separate", () => {
  let chat = startTurn(emptyChat(), "x");
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "One." } });
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "Two." } });
  assert.equal(chat.turns[0].items.length, 2);
});

test("replayed history opens a turn per user message", () => {
  let chat = emptyChat();
  chat = applySessionUpdate(chat, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" } });
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } });
  chat = applySessionUpdate(chat, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "second" } });
  chat = endTurn(chat, "end_turn");
  assert.deepEqual(chat.turns.map((turn) => turn.prompt), ["first", "second"]);
  assert.ok(chat.turns.every((turn) => turn.endedAt !== null));
});

test("permission requests are pending until resolved", () => {
  let chat = startTurn(emptyChat(), "x");
  chat = addPermission(chat, "p1", "Run npm test", [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ]);
  assert.equal(pendingPermission(chat)?.id, "p1");
  chat = resolvePermission(chat, "p1", "allow");
  assert.equal(pendingPermission(chat), undefined);
});

test("normalizes config options and legacy modes/models", () => {
  const options = optionsFromSession({
    models: { currentModelId: "sonnet", availableModels: [{ modelId: "sonnet", name: "Sonnet" }] },
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "bypassPermissions", name: "Bypass" }] },
    configOptions: [{
      id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: "high",
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    }],
  });
  assert.deepEqual(options.map((option) => [option.id, option.source, option.value]), [
    ["model", "model", "sonnet"],
    ["effort", "config", "high"],
    ["mode", "mode", "default"],
  ]);
});
