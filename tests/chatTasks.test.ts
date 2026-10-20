import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { applySessionUpdate, emptyChat, endTurn, isOutputDelta, startTurn } from "../src/lib/acp/chatModel.ts";
import { applyWorkerNotification as update } from "../src/lib/acp/chatWorkers.ts";
import { backgroundWork, backgroundWorkLabel, disconnectTasks, runningTasks } from "../src/lib/acp/chatTasks.ts";
import { createStreamBatch } from "../src/lib/acp/streamBatch.ts";

const initial = () => startTurn({ ...emptyChat(), acpSessionId: "root" }, "Start the dev server");
const spawned = (id: string, extra: object = {}) => ({
  sessionUpdate: "async_task_spawned", asyncTaskId: id, name: "Bash", taskType: "shell", description: "pnpm dev", canStop: true, ...extra,
});
const state = (id: string, value: string, extra: object = {}) => ({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state: value, ...extra });
const delta = (toolCallId: string, data: string) => ({ sessionUpdate: "tool_call_update", toolCallId, _meta: { terminal_output_delta: { data, terminal_id: toolCallId } } });

test("a backgrounded command becomes a task in the turn of its tool call and settles once", () => {
  let chat = update(initial(), "root", { sessionUpdate: "tool_call", toolCallId: "bash-1", title: "pnpm dev", kind: "execute", status: "in_progress" });
  chat = endTurn(chat, "end_turn");
  chat = startTurn(chat, "Next question");
  chat = update(chat, "root", spawned("t1", { toolCallId: "bash-1", outputFilePath: "/tmp/claude-501/tasks/t1.output" }), 10);
  assert.equal(chat.tasks?.length, 1);
  assert.equal(chat.tasks?.[0].turnId, 0, "sits with the call that started it, not the current turn");
  assert.equal(chat.tasks?.[0].outputFile, "/tmp/claude-501/tasks/t1.output");
  assert.equal(runningTasks(chat).length, 1);

  chat = update(chat, "root", state("t1", "completed", { summary: "Exited with code 0" }), 50);
  assert.equal(chat.tasks?.[0].state, "completed");
  assert.equal(chat.tasks?.[0].endedAt, 50);
  assert.equal(chat.tasks?.[0].summary, "Exited with code 0");
  // Announced again later: details may improve, but it doesn't come back to life.
  chat = update(chat, "root", spawned("t1"), 60);
  assert.equal(chat.tasks?.[0].state, "completed");
  assert.equal(runningTasks(chat).length, 0);
});

test("updates for tasks never announced, relative output paths and unknown sessions are ignored", () => {
  let chat = update(initial(), "root", state("ghost", "completed"));
  assert.equal(chat.tasks, undefined);
  chat = update(chat, "root", spawned("t1", { outputFilePath: "relative.output" }));
  assert.equal(chat.tasks?.[0].outputFile, undefined);
  chat = update(chat, "stranger", spawned("t2"));
  assert.equal(chat.tasks?.length, 1);
});

test("a delegated agent's task is its own, sits in that agent's turn, and can share an id", () => {
  let chat = update(initial(), "root", { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "Builder", task: "Build" });
  chat = update(chat, "root", spawned("same"));
  chat = update(chat, "child", spawned("same", { description: "cargo build" }));
  assert.deepEqual(chat.tasks?.map(task => [task.ownerSessionId ?? "root", task.description, task.turnId]), [["root", "pnpm dev", 0], ["child", "cargo build", 0]]);
  chat = update(chat, "child", state("same", "stopped"));
  assert.deepEqual(chat.tasks?.map(task => task.state), ["running", "stopped"]);
  assert.deepEqual(backgroundWork(chat), { tasks: 1, agents: 1 });
  assert.equal(backgroundWorkLabel(backgroundWork(chat)), "1 background command and 1 agent");
  assert.equal(backgroundWorkLabel({ tasks: 2, agents: 0 }), "2 background commands");
  assert.equal(backgroundWorkLabel({ tasks: 0, agents: 0 }), null);
});

test("a disconnected agent leaves its running tasks without a known outcome", () => {
  let chat = update(update(initial(), "root", spawned("a")), "root", spawned("b"));
  chat = update(chat, "root", state("b", "failed"));
  chat = disconnectTasks(chat);
  assert.deepEqual(chat.tasks?.map(task => task.state), ["disconnected", "failed"]);
  assert.equal(disconnectTasks(chat), chat, "nothing left to change");
});

test("streamed output appends to its tool call, and the exit code and background marker stick", () => {
  let chat = applySessionUpdate(initial(), { sessionUpdate: "tool_call", toolCallId: "c", title: "Run tests", kind: "execute", status: "in_progress", rawInput: { command: "pnpm test" } });
  chat = applySessionUpdate(chat, delta("c", "one\n"));
  chat = applySessionUpdate(chat, delta("c", "two\n"));
  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", _meta: { terminal_exit: { exit_code: 1, signal: null } } });
  const tool = chat.turns[0].items[0];
  assert.equal(tool.kind === "tool" && tool.output, "one\ntwo\n");
  assert.equal(tool.kind === "tool" && tool.exitCode, 1);
  assert.equal(tool.kind === "tool" && tool.title, "pnpm test", "output chunks keep the title");

  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call", toolCallId: "bg", title: "pnpm dev", kind: "execute", status: "in_progress" });
  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed", _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } });
  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed" });
  const background = chat.turns[0].items[1];
  assert.equal(background.kind === "tool" && background.backgrounded, true);
});

test("only an update carrying nothing but output counts as an output chunk", () => {
  assert.equal(isOutputDelta(delta("c", "x")), true);
  assert.equal(isOutputDelta({ ...delta("c", "x"), status: "completed" }), false);
  assert.equal(isOutputDelta({ sessionUpdate: "tool_call_update", toolCallId: "c", _meta: { terminal_output_delta: { data: "x" }, terminal_exit: { exit_code: 0 } } }), false);
  assert.equal(isOutputDelta({ sessionUpdate: "tool_call", toolCallId: "c", _meta: { terminal_output_delta: { data: "x" } } }), false);
});

function clock(t: TestContext) {
  const frames = new Map<number, () => void>();
  let id = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => ++id,
    clearTimeout: () => {},
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { frame: () => [...frames.values()].forEach(fn => fn()) };
}

test("a burst of output chunks publishes once, merged per tool call and session", t => {
  const time = clock(t);
  const published: unknown[][] = [];
  const batch = createStreamBatch(updates => published.push(updates));
  for (let i = 0; i < 500; i++) batch.enqueueOutput({ ...delta("c", "x"), sessionUpdate: "tool_call_update", _meta: { terminal_output_delta: { data: "x" } } });
  batch.enqueueOutput({ sessionUpdate: "tool_call_update", toolCallId: "c", routeSessionId: "child", _meta: { terminal_output_delta: { data: "y" } } });
  batch.enqueueOutput({ sessionUpdate: "tool_call_update", toolCallId: "d", _meta: { terminal_output_delta: { data: "z" } } });
  assert.equal(published.length, 0);
  time.frame();
  assert.equal(published.length, 1);
  const outputs = published[0].map(update => (update as { _meta: { terminal_output_delta: { data: string } } })._meta.terminal_output_delta.data);
  assert.deepEqual(outputs.map(text => text.length), [500, 1, 1]);
  const chat = (published[0] as Parameters<typeof applySessionUpdate>[1][]).filter(update => !update.routeSessionId)
    .reduce(applySessionUpdate, applySessionUpdate(initial(), { sessionUpdate: "tool_call", toolCallId: "c", title: "x", kind: "execute" }));
  assert.equal(chat.turns[0].items[0].kind === "tool" && chat.turns[0].items[0].output.length, 500);
});
