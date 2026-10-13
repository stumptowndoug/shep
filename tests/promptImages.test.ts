import assert from "node:assert/strict";
import test from "node:test";
import { emptyChat, endTurn, markQueuedPromptsUnsent, RECENT_TURN_LIMIT, startTurn } from "../src/lib/acp/chatModel.ts";
import { fittedSize } from "../src/lib/acp/promptImages.ts";

const image = { mimeType: "image/png", data: "AAAA", name: "shot.png" };

test("images keep their size until the longest edge passes the limit", () => {
  assert.equal(fittedSize(1600, 900), null);
  assert.equal(fittedSize(2000, 2000), null);
  assert.deepEqual(fittedSize(3000, 1200), { width: 2000, height: 800 });
  assert.deepEqual(fittedSize(1000, 4000), { width: 500, height: 2000 });
});

test("a turn carries its images, and older history releases them but remembers how many", () => {
  let chat = endTurn(startTurn(emptyChat(), "Look", [], [image, image]), "end_turn");
  assert.equal(chat.turns[0].images?.length, 2);
  for (let i = 0; i < RECENT_TURN_LIMIT; i++) chat = endTurn(startTurn(chat, `next ${i}`), "end_turn");
  assert.equal(chat.turns[0].images, undefined);
  assert.equal(chat.turns[0].trimmedImages, 2);
});

test("stopping keeps queued text visible and notes queued images that weren't sent", () => {
  const chat = markQueuedPromptsUnsent({ ...emptyChat(), queued: ["and this"], queuedImages: [image] });
  assert.deepEqual(chat.unsentPrompts.map(prompt => prompt.text), ["and this", "1 image"]);
  assert.deepEqual(chat.queuedImages, []);
  assert.equal(markQueuedPromptsUnsent({ ...emptyChat(), queuedImages: [image, image] }).unsentPrompts[0].text, "2 images");
});
