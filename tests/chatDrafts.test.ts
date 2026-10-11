import assert from "node:assert/strict";
import test from "node:test";
import { chatDraftKey, createChatDraftStore } from "../src/stores/useChatDraftStore.ts";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test("drafts stay isolated by agent, project and session and survive a reload", () => {
  const disk = storage();
  const keys = [chatDraftKey("claude", "/repo", "a"), chatDraftKey("pi", "/repo", "a"), chatDraftKey("claude", "/other", "a"), chatDraftKey("claude", "/repo", "b")];
  const store = createChatDraftStore(() => disk);
  keys.forEach((key, i) => store.getState().setDraft(key, `Draft ${i}`));
  const restored = createChatDraftStore(() => disk);
  keys.forEach((key, i) => { restored.getState().load(key); assert.equal(restored.getState().drafts[key], `Draft ${i}`); });
  restored.getState().setDraft(keys[0], "");
  const reloaded = createChatDraftStore(() => disk);
  keys.forEach(key => reloaded.getState().load(key));
  assert.equal(reloaded.getState().drafts[keys[0]], "");
  assert.equal(reloaded.getState().drafts[keys[1]], "Draft 1");
});

test("draft typed during startup moves to the durable provider session", () => {
  const disk = storage();
  const store = createChatDraftStore(() => disk);
  store.getState().setDraft("pending", "Keep my message");
  store.getState().moveDraft("pending", "session");
  store.getState().moveDraft("session", "session");
  assert.equal(store.getState().drafts.pending, "");
  assert.equal(store.getState().drafts.session, "Keep my message");
  const restored = createChatDraftStore(() => disk);
  restored.getState().moveDraft("new-pending", "session");
  assert.equal(restored.getState().drafts.session, "Keep my message");
});

test("blocked storage preserves drafts in memory, including clearing", () => {
  const store = createChatDraftStore(() => { throw new Error("Unavailable"); });
  store.getState().load("chat");
  store.getState().setDraft("chat", "Unsent");
  store.getState().load("chat");
  assert.equal(store.getState().drafts.chat, "Unsent");
  store.getState().setDraft("chat", "");
  assert.equal(store.getState().drafts.chat, "");
});
