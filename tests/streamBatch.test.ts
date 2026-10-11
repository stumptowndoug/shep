import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createStreamBatch } from "../src/lib/acp/streamBatch.ts";
import { applySessionUpdate, emptyChat, startTurn } from "../src/lib/acp/chatModel.ts";

function clock(t: TestContext) {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { frames, timers, frame: () => [...frames.values()].forEach(fn => fn()), tick: () => [...timers.values()].forEach(fn => fn()) };
}

const chunk = (text: string, messageId?: string, sessionUpdate = "agent_message_chunk") => ({ sessionUpdate, messageId, content: { type: "text" as const, text } });

test("a burst of 1,000 tokens publishes once per frame and preserves message boundaries", t => {
  const time = clock(t);
  const publications: Parameters<Parameters<typeof createStreamBatch>[0]>[0][] = [];
  const batch = createStreamBatch(updates => publications.push(updates));
  const chunks = [...Array.from({ length: 1000 }, () => chunk("x", "a")), chunk(" anonymous"), chunk("new", "b"), chunk("thinking", "b", "agent_thought_chunk")];
  for (const update of chunks) batch.enqueue(update);
  assert.equal(publications.length, 0);
  assert.equal(time.frames.size, 1);
  time.frame();
  assert.equal(publications.length, 1);
  assert.equal(publications[0].length, 4);
  assert.equal(publications[0][0].content.text.length, 1000);
  const initial = startTurn(emptyChat(), "prompt");
  const before = chunks.reduce(applySessionUpdate, initial);
  const after = publications[0].reduce(applySessionUpdate, initial);
  const textItems = (state: typeof before) => state.turns[0].items.map(item => item.kind === "message" || item.kind === "thought" ? [item.kind, item.text, item.messageId] : item.kind);
  assert.deepEqual(textItems(after), textItems(before));
  assert.equal(chunks[0].content.text, "x");
  assert.equal(time.timers.size, 0);
});

test("lifecycle flush preserves the last tokens; discard cannot publish after close", t => {
  const time = clock(t);
  const values: string[] = [];
  const batch = createStreamBatch(updates => values.push(updates.map(update => update.content.text).join("")));
  batch.enqueue(chunk("final answer"));
  batch.flush();
  assert.deepEqual(values, ["final answer"]);
  batch.enqueue(chunk("closed tab"));
  batch.discard();
  time.frame();
  time.tick();
  batch.flush();
  assert.deepEqual(values, ["final answer"]);
  assert.equal(time.frames.size, 0);
  assert.equal(time.timers.size, 0);
});

test("background windows and large bursts cannot retain an unbounded pending stream", t => {
  const time = clock(t);
  let text = "";
  const batch = createStreamBatch(updates => { text += updates.map(update => update.content.text).join(""); });
  batch.enqueue(chunk("background"));
  time.tick();
  assert.equal(text, "background");
  assert.equal(time.frames.size, 0);
  batch.enqueue(chunk("x".repeat(64_000)));
  assert.equal(text.length, 64_010);
  assert.equal(time.frames.size, 0);
});
