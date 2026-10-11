import assert from "node:assert/strict";
import test from "node:test";
import { applyCursorNotification, parseCursorRequest, validCursorOutcome } from "../src/lib/acp/cursorProtocol.ts";
import { addCursorRequest, emptyChat, pendingRequest, resolveCursorRequest, startTurn } from "../src/lib/acp/chatModel.ts";
import { isAccessOption } from "../src/lib/acp/chatOptions.ts";

const question = { toolCallId: "q", title: "Choose scope", questions: [
  { id: "scope", prompt: "What should change?", options: [{ id: "chat", label: "Chat" }, { id: "all", label: "Everywhere" }] },
  { id: "checks", prompt: "Which checks?", allowMultiple: true, options: [{ id: "unit", label: "Unit tests" }, { id: "ui", label: "UI" }] },
] };
const plan = { toolCallId: "p", name: "Chat refresh", overview: "Keep the scope small.", plan: "1. Inspect\n2. Update\n3. Test", todos: [{ id: "1", content: "Inspect", status: "completed" }] };

test("Cursor questions enforce single/multiple choices and preserve opaque option ids", () => {
  const request = parseCursorRequest("cursor/ask_question", question)!;
  assert.equal(request.kind, "question");
  assert.equal(validCursorOutcome(request, { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["chat"] }, { questionId: "checks", selectedOptionIds: ["unit", "ui"] }] }), true);
  for (const answers of [
    [],
    [{ questionId: "scope", selectedOptionIds: ["chat", "all"] }, { questionId: "checks", selectedOptionIds: ["ui"] }],
    [{ questionId: "scope", selectedOptionIds: ["invented"] }, { questionId: "checks", selectedOptionIds: ["ui"] }],
    [{ questionId: "scope", selectedOptionIds: ["chat"] }, { questionId: "checks", selectedOptionIds: ["ui", "ui"] }],
    [{ questionId: "scope", selectedOptionIds: ["chat"] }, { questionId: "scope", selectedOptionIds: ["all"] }],
  ]) assert.equal(validCursorOutcome(request, { outcome: "answered", answers }), false);
  assert.equal(validCursorOutcome(request, { outcome: "skipped" }), true);
  assert.equal(validCursorOutcome(request, { outcome: "accepted" }), false);
});

test("plan approval accepts only an explicit plan outcome", () => {
  const request = parseCursorRequest("cursor/create_plan", plan)!;
  for (const outcome of ["accepted", "rejected", "cancelled"] as const) assert.equal(validCursorOutcome(request, { outcome }), true);
  assert.equal(validCursorOutcome(request, { outcome: "skipped" }), false);
  let state = addCursorRequest(startTurn(emptyChat(), "Plan this"), "approval", request);
  assert.equal(pendingRequest(state)?.id, "approval");
  state = resolveCursorRequest(state, "approval", { outcome: "rejected" });
  assert.equal(pendingRequest(state), undefined);
});

test("invalid or oversized approval content is rejected rather than silently clipped", () => {
  assert.throws(() => parseCursorRequest("cursor/create_plan", { ...plan, plan: "x".repeat(48_001) }));
  assert.throws(() => parseCursorRequest("cursor/ask_question", { ...question, questions: [] }));
  assert.throws(() => parseCursorRequest("cursor/ask_question", { ...question, questions: [question.questions[0], question.questions[0]] }));
  assert.throws(() => parseCursorRequest("cursor/ask_question", { ...question, questions: [{ ...question.questions[0], options: [] }] }));
  assert.equal(parseCursorRequest("cursor/unknown", {}), null);
});

test("Cursor todo updates merge by id, preserve cancelled status and support replacement", () => {
  let state = startTurn(emptyChat(), "Build it");
  state = applyCursorNotification(state, "cursor/update_todos", { todos: [{ id: "a", content: "Inspect", status: "pending" }, { id: "b", content: "Build", status: "pending" }], merge: false });
  state = applyCursorNotification(state, "cursor/update_todos", { todos: [{ id: "a", content: "Inspected", status: "completed" }, { id: "c", content: "Extra", status: "cancelled" }], merge: true });
  const entry = state.turns[0].items[0];
  assert.equal(entry.kind, "plan");
  if (entry.kind === "plan") assert.deepEqual(entry.entries.map(todo => [todo.id, todo.status]), [["a", "completed"], ["b", "pending"], ["c", "cancelled"]]);
  state = applyCursorNotification(state, "cursor/update_todos", { todos: [], merge: false });
  const cleared = state.turns[0].items[0];
  assert.equal(cleared.kind === "plan" && cleared.entries.length, 0);
  assert.equal(applyCursorNotification(state, "cursor/update_todos", { todos: "bad" }), state);
});

test("optional task/image notifications render bounded details without opening local files", () => {
  let state = startTurn(emptyChat(), "Inspect");
  state = applyCursorNotification(state, "cursor/task", { toolCallId: "task-1", description: "Review code" });
  state = applyCursorNotification(state, "cursor/generate_image", { toolCallId: "image-1", description: "Preview", filePath: "/tmp/preview.png" });
  assert.equal(state.turns[0].items.length, 2);
  const image = state.turns[0].items[1];
  assert.equal(image.kind === "tool" && image.output, "/tmp/preview.png");
});

test("Cursor Agent, Plan and Ask remain modes rather than permission policies", () => {
  assert.equal(isAccessOption({ id: "mode", name: "Mode", category: "mode", source: "config", value: "agent", choices: [
    { value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }, { value: "ask", name: "Ask" },
  ] }), false);
});
