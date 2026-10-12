import assert from "node:assert/strict";
import test from "node:test";

import {
  addPermission,
  applySessionUpdate,
  emptyChat,
  endTurn,
  optionsFromSession,
  pendingPermission,
  removeStartupMessage,
  resolvePermission,
  startTurn,
  trimOldTurnDetails,
} from "../src/lib/acp/chatModel.ts";

test("only heavy content outside the recent 50 completed turns is trimmed", () => {
  let chat = emptyChat();
  for (let i = 0; i < 50; i++) {
    chat = startTurn(chat, `prompt ${i}`);
    chat = applySessionUpdate(chat, { sessionUpdate: "tool_call", toolCallId: String(i), title: "file.ts", kind: "edit", status: "completed", rawOutput: "old tool output",
      content: [{ type: "diff", path: "file.ts", oldText: "before", newText: "after" }] });
    chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "YWJj" } });
    chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com/file", name: "Source" } });
    chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer ${i}` } });
    chat = endTurn(chat, "end_turn");
  }
  const original = chat;
  chat = startTurn(chat, "current prompt");
  const [old] = chat.turns;
  assert.equal(old.prompt, "prompt 0");
  assert.equal(old.endedAt, original.turns[0].endedAt);
  assert.equal(old.stopReason, "end_turn");
  assert.equal(old.detailsTrimmed, true);
  const tool = old.items[0];
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") return;
  assert.equal(tool.title, "file.ts");
  assert.equal(tool.status, "completed");
  assert.equal(tool.output, "");
  assert.deepEqual(tool.diffs, []);
  assert.equal(tool.outputTrimmed, true);
  assert.equal(old.items[1].kind, "notice");
  assert.equal(old.items[2], original.turns[0].items[2]);
  assert.equal(old.items[3], original.turns[0].items[3]);
  assert.equal(chat.turns[1], original.turns[1]);
  assert.equal(chat.turns[49], original.turns[49]);
  assert.equal(trimOldTurnDetails(chat), chat);
  assert.equal(original.turns[0].items[1].kind, "media");

  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call_update", toolCallId: "0", status: "failed", rawOutput: "late heavy output",
    content: [{ type: "diff", path: "file.ts", oldText: "late before", newText: "late after" }] });
  const late = chat.turns[0].items[0];
  assert.equal(late.kind === "tool" && late.status, "failed");
  assert.equal(late.kind === "tool" && late.output, "");
  assert.deepEqual(late.kind === "tool" && late.diffs, []);
  assert.equal(chat.turns[50].items.length, 0);
});

test("history replay trims old payloads while preserving every prompt and answer", () => {
  let chat = emptyChat();
  for (let i = 0; i < 75; i++) {
    chat = applySessionUpdate(chat, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `prompt ${i}` } });
    chat = applySessionUpdate(chat, { sessionUpdate: "tool_call", toolCallId: String(i), status: "completed", rawOutput: "output" });
    chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer ${i}` } });
  }
  chat = endTurn(chat, "end_turn");
  assert.equal(chat.turns.length, 75);
  for (const [i, turn] of chat.turns.entries()) {
    assert.equal(turn.prompt, `prompt ${i}`);
    assert.equal(turn.items[1].kind === "message" && turn.items[1].text, `answer ${i}`);
    assert.equal(turn.items[0].kind === "tool" && turn.items[0].output, i < 25 ? "" : "output");
  }
});

test("retention never strips an unfinished turn", () => {
  const live = applySessionUpdate(startTurn(emptyChat(), "working"), { sessionUpdate: "tool_call", toolCallId: "active", status: "in_progress", rawOutput: "live output" });
  const chat = { ...live, turns: [live.turns[0], ...Array.from({ length: 50 }, (_, i) => ({ ...live.turns[0], id: i + 1, endedAt: 2 }))] };
  assert.equal(trimOldTurnDetails(chat), chat);
});

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

test("late chunks and tool updates do not reopen turns or duplicate tools", () => {
  let chat = startTurn(emptyChat(), "first");
  chat = applySessionUpdate(chat, OPENCODE_TURN[2]);
  chat = endTurn(chat, "end_turn");
  const endedAt = chat.turns[0].endedAt;
  chat = applySessionUpdate(chat, OPENCODE_TURN[4]);
  chat = applySessionUpdate(chat, {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Late answer"}});
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].endedAt, endedAt);
  assert.equal(chat.turns[0].items.filter(item => item.kind === "tool").length, 1);
  chat = startTurn(chat, "second");
  chat = applySessionUpdate(chat, OPENCODE_TURN[4]);
  assert.equal(chat.turns[1].items.length, 0);
  assert.equal(chat.turns[0].endedAt, endedAt);
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

test("keeps setting categories and explanations for clearly labeled composer controls", () => {
  const [option] = optionsFromSession({configOptions:[{
    id:"fast",name:"Fast mode",description:"Faster responses on supported models",category:"model_config",type:"select",currentValue:"off",
    options:[{value:"on",name:"On",description:"Use fast responses"},{value:"off",name:"Off"}],
  }]});
  assert.equal(option.category, "model_config");
  assert.equal(option.description, "Faster responses on supported models");
  assert.equal(option.choices[0].description, "Use fast responses");
});

test("fast-mode notices stay outside streamed answers and do not change turn status", () => {
  let chat = startTurn({ ...emptyChat(), status: "working" }, "Why is the sky blue?");
  chat = applySessionUpdate(chat, {
    sessionUpdate: "notice", severity: "warning", title: "Fast mode turned off",
    description: "Requires extra usage to be enabled for this account.",
  });
  chat = applySessionUpdate(chat, {
    sessionUpdate: "config_option_update", configOptions: [{
      id: "fast", name: "Fast mode", type: "select", currentValue: "off",
      options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }],
    }],
  });
  for (const text of ["It’s because of Rayleigh scattering.", " Air molecules scatter blue light."]) {
    chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }
  assert.equal(chat.status, "working");
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].endedAt, null);
  assert.equal(chat.turns[0].items.length, 1);
  assert.equal(chat.turns[0].items[0].kind === "message" && chat.turns[0].items[0].text, "It’s because of Rayleigh scattering. Air molecules scatter blue light.");
  assert.equal(chat.notices[0].title, "Fast mode turned off");
  assert.equal(chat.options[0].value, "off");
});

test("live notices coalesce without opening history turns and preserve unknown severities", () => {
  const notice = { sessionUpdate: "notice", severity: "_custom", title: "Agent status", description: null };
  let chat = applySessionUpdate(emptyChat(), notice);
  chat = applySessionUpdate(chat, notice);
  assert.equal(chat.notices.length, 1);
  assert.equal(chat.notices[0].severity, "_custom");
  assert.equal(chat.notices[0].description, null);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.error, null);
  assert.equal(applySessionUpdate(chat, { ...notice, title: "  " }), chat);
});

test("Pi's identified startup prelude is removed without hiding warnings or prompted replies", () => {
  const banner = "pi v1.1.0\n---\n## Extensions\n- npm:pi-web-access\n";
  let chat = applySessionUpdate(emptyChat(), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: banner } });
  chat = applySessionUpdate(chat, { sessionUpdate: "notice", severity: "warning", title: "Provider unavailable" });
  chat = removeStartupMessage(chat, banner);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.notices[0].title, "Provider unavailable");
  chat = startTurn(chat, "Print this banner exactly");
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: banner } });
  assert.equal(removeStartupMessage(chat, banner), chat);
  assert.equal(removeStartupMessage(chat, "unrelated text"), chat);
});

test("Pi's legacy thinking modes do not duplicate its modern reasoning control", () => {
  const choices = [{ value: "low", name: "Thinking: low" }, { value: "high", name: "Thinking: high" }];
  const options = optionsFromSession({
    configOptions: [{ id: "thought_level", name: "Thinking", type: "select", category: "thought_level", currentValue: "high", options: choices }],
    modes: { currentModeId: "high", availableModes: choices.map((choice) => ({ id: choice.value, name: choice.name })) },
  });
  assert.deepEqual(options.map((option) => [option.id, option.source]), [["thought_level", "config"]]);
});

test("file tool titles show the file however each agent phrases them", () => {
  const titleOf = (update: Record<string, unknown>) => {
    const chat = applySessionUpdate(startTurn(emptyChat(), "p"), { sessionUpdate: "tool_call", toolCallId: "t", kind: "edit", status: "completed", ...update });
    const item = chat.turns[0].items[0];
    return item.kind === "tool" ? item.title : null;
  };
  const diff = [{ type: "diff", path: "/repo/src/report.sql", oldText: "a", newText: "b" }];
  assert.equal(titleOf({ title: "Edit `/private/tmp/repo/report.sql`" }), "report.sql");
  assert.equal(titleOf({ title: "edit_file: report.sql" }), "report.sql");
  assert.equal(titleOf({ title: "Editing files", content: diff }), "report.sql");
  assert.equal(titleOf({ title: "Running edit_file", content: diff }), "report.sql");
  assert.equal(titleOf({ title: "Read file '/repo/src/report.sql'", kind: "read" }), "report.sql");
  // A title that names something else, or has no file to fall back on, is kept.
  assert.equal(titleOf({ title: "Update the README intro" }), "Update the README intro");
  assert.equal(titleOf({ title: "Editing files" }), "Editing files");
});
