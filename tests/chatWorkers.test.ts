import assert from "node:assert/strict";
import test from "node:test";
import { addPermission, emptyChat, endTurn, pendingRequest, startTurn } from "../src/lib/acp/chatModel.ts";
import { applyWorkerNotification as update, disconnectWorkers, runningWorkers, waitingWorkerIds, workerCapabilities, workerSummary, workerTree } from "../src/lib/acp/chatWorkers.ts";

const initial = () => startTurn({ ...emptyChat(), acpSessionId: "root" }, "Delegate this");
const spawn = (id: string) => ({ sessionUpdate: "subagent_spawned", subagentSessionId: id, name: id, task: "Review the change", capabilities: {} });
const chunk = (value: string) => ({ sessionUpdate: "agent_message_chunk", messageId: "same", content: { type: "text", text: value } });
const done = (id: string, state = "completed") => ({ sessionUpdate: "subagent_state_update", subagentSessionId: id, state });

test("interleaved children with identical message/tool ids keep separate transcripts and settings", () => {
  let chat = update(update(initial(), "root", spawn("a")), "root", spawn("b"));
  for (const id of ["root", "a", "b"]) {
    chat = update(chat, id, chunk(id));
    chat = update(chat, id, { sessionUpdate: "tool_call", toolCallId: "same", title: id, status: "in_progress" });
  }
  chat = update(chat, "a", { sessionUpdate: "tool_call_update", toolCallId: "same", status: "completed" });
  chat = update(chat, "b", { sessionUpdate: "usage_update", used: 5, size: 10 });
  assert.equal(chat.turns[0].items[0].kind === "message" && chat.turns[0].items[0].text, "root");
  assert.equal(chat.turns[0].items[1].kind === "tool" && chat.turns[0].items[1].status, "in_progress");
  assert.deepEqual(chat.workers?.map(worker => worker.chat.turns[0].items[0]).map(item => item.kind === "message" && item.text), ["a", "b"]);
  assert.equal(chat.usage, null);
  assert.deepEqual(chat.workers?.[1].chat.usage, { used: 5, size: 10 });
});

test("worker lifetime outlasts parent turns and launch tool completion; silence and late output cannot change it", () => {
  let chat = update(initial(), "root", spawn("a"), 10);
  chat = update(chat, "root", { sessionUpdate: "tool_call", toolCallId: "spawn", status: "completed" });
  chat = endTurn(chat, "end_turn");
  assert.equal(runningWorkers(chat).length, 1);
  chat = update(chat, "root", done("a"), 100);
  chat = update(chat, "a", chunk("late result"), 101);
  chat = update(chat, "root", spawn("a"), 102);
  assert.equal(runningWorkers(chat).length, 0);
  assert.equal(chat.workers?.length, 1);
  assert.equal(chat.workers?.[0].endedAt, 100);
  assert.equal(chat.workers?.[0].state, "completed");
  assert.equal(chat.workers?.[0].chat.turns[0].items.length, 1);
});

test("nested children require their announced parent and cannot reparent or overwrite the root", () => {
  let chat = update(initial(), "root", spawn("a"));
  chat = update(chat, "a", spawn("b"));
  assert.equal(chat.workers?.[1].parentSessionId, "a");
  assert.equal(update(chat, "root", spawn("b")), chat);
  assert.equal(update(chat, "root", spawn("root")), chat);
  assert.equal(update(chat, "unknown", chunk("hidden")), chat);
  assert.equal(update(chat, "root", done("b")), chat);
  assert.equal(update(chat, "a", done("b")).workers?.[1].state, "completed");
});

test("replay remains settled and a new generation retains its independent state", () => {
  let chat = update(initial(), "root", { ...spawn("a"), prompt: "Assignment" });
  chat = update(chat, "a", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Assignment" } });
  assert.equal(chat.workers?.[0].chat.turns[0].prompt, "Assignment");
  chat = update(chat, "root", done("a"));
  chat = update(chat, "root", spawn("a:generation:2"));
  assert.deepEqual(chat.workers?.map(worker => worker.state), ["completed", "running"]);
});

test("child approvals survive parent completion and the next parent prompt", () => {
  let chat = update(initial(), "root", spawn("a"));
  chat = addPermission(chat, "p", "a: run tests", [{ optionId: "yes", name: "Allow", kind: "allow_once" }], "a");
  chat = startTurn(endTurn(chat, "end_turn"), "Next question");
  assert.equal(pendingRequest(chat)?.id, "p");
  assert.match(workerSummary(chat)!, /1 agent running · 1 needs permission/);
});

test("transport loss preserves known outcomes and labels unfinished work unknown", () => {
  let chat = update(update(initial(), "root", spawn("a")), "root", spawn("b"));
  chat = update(chat, "root", done("a", "failed"));
  chat = disconnectWorkers(chat);
  assert.deepEqual(chat.workers?.map(worker => worker.state), ["failed", "disconnected"]);
  assert.match(workerSummary(chat)!, /1 failed · 1 status unknown/);
});

test("child output retention is bounded independently of parent history", () => {
  let chat = update(initial(), "root", spawn("a"));
  for (let i = 0; i < 150; i++) chat = update(chat, "a", { ...chunk("x".repeat(5000)), messageId: String(i) });
  assert.ok(JSON.stringify(chat.workers?.[0].chat.turns).length < 67_000);
  assert.equal(chat.workers?.[0].transcriptTrimmed, true);
  assert.equal(runningWorkers(chat).length, 1);
  assert.equal(chat.turns[0].items.length, 0);
});

test("only supported adapters opt into the implemented legacy child contract", () => {
  assert.deepEqual(workerCapabilities("pi"), {});
  assert.deepEqual(workerCapabilities("claude")._meta?.jetbrains.air.capabilities, ["nativeSubagentSessions"]);
  assert.equal("subagents" in workerCapabilities("codex"), false);
});

test("agents remember the turn that started them, and nested agents share their parent's", () => {
  let chat = update(initial(), "root", spawn("a"));
  chat = startTurn(endTurn(chat, "end_turn"), "Next");
  chat = update(update(chat, "root", spawn("b")), "a", spawn("a1"));
  assert.deepEqual(chat.workers?.map(worker => [worker.sessionId, worker.turnId]), [["a", 0], ["b", 1], ["a1", 0]]);
  assert.equal(update({ ...emptyChat(), acpSessionId: "root" }, "root", spawn("early")).workers?.[0].turnId, undefined);
});

test("the agent tree lists nested agents under their parent in spawn order", () => {
  let chat = update(update(initial(), "root", spawn("a")), "root", spawn("b"));
  chat = update(update(chat, "a", spawn("a1")), "a1", spawn("a2"));
  assert.deepEqual(workerTree(chat.workers!).map(({ worker, depth }) => `${worker.sessionId}:${depth}`), ["a:0", "a1:1", "a2:2", "b:0"]);
});

test("waiting agents are those with an unanswered permission", () => {
  let chat = update(update(initial(), "root", spawn("a")), "root", spawn("b"));
  chat = addPermission(addPermission(chat, "p1", "Run", [], "b"), "p2", "Run", [], "b");
  assert.deepEqual(waitingWorkerIds(chat), ["b"]);
  assert.equal(workerSummary(chat), "2 agents running · 1 needs permission");
});

