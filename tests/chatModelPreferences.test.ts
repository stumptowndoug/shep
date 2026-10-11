import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatModelStore } from "../src/stores/useChatModelStore.ts";

function storage(initial = "{}") {
  let saved = initial;
  return { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
}

test("model choices persist per agent across restarts and resetting one keeps the others", () => {
  const disk = storage();
  const store = createChatModelStore(() => disk);
  assert.deepEqual(store.getState().models, {});
  store.getState().remember("pi", { id: "anthropic/opus", name: "Anthropic / Opus" });
  store.getState().remember("opencode", { id: "openai/codex", name: "OpenAI / Codex" });
  const restarted = createChatModelStore(() => disk);
  assert.deepEqual(restarted.getState().models, store.getState().models);
  restarted.getState().useAgentDefault("pi");
  assert.deepEqual(createChatModelStore(() => disk).getState().models, {
    opencode: { id: "openai/codex", name: "OpenAI / Codex" },
  });
});

test("invalid saved preferences fall back safely without losing valid agents", () => {
  for (const raw of ["invalid JSON", "null", "[]", "42"]) {
    assert.deepEqual(createChatModelStore(() => storage(raw)).getState().models, {});
  }
  const disk = storage(JSON.stringify({ pi: { id: "opus", name: "Opus" }, claude: null, codex: { id: "" }, opencode: { id: 12, name: "Wrong type" } }));
  assert.deepEqual(createChatModelStore(() => disk).getState().models, { pi: { id: "opus", name: "Opus" } });
});

test("unavailable storage does not prevent choosing or clearing models", () => {
  const store = createChatModelStore(() => { throw new Error("Storage blocked"); });
  store.getState().remember("pi", { id: "opus", name: "Opus" });
  assert.equal(store.getState().models.pi.id, "opus");
  store.getState().useAgentDefault("pi");
  assert.deepEqual(store.getState().models, {});
});
