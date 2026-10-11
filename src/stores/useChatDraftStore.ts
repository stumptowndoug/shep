import { create } from "zustand";

const PREFIX = "shep:chat-draft:";
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Provider session ids survive app restarts; native process ids do not. */
export function chatDraftKey(assistantId: string, repoPath: string, sessionId: string): string {
  return JSON.stringify([assistantId, repoPath, sessionId]);
}

interface ChatDraftStore {
  drafts: Record<string, string>;
  load: (key: string) => void;
  setDraft: (key: string, text: string) => void;
  moveDraft: (from: string, to: string) => void;
}

export function createChatDraftStore(storage: () => DraftStorage) {
  return create<ChatDraftStore>((set, get) => ({
    drafts: {},
    load: (key) => {
      if (Object.prototype.hasOwnProperty.call(get().drafts, key)) return;
      let text = "";
      try { text = storage().getItem(PREFIX + key) ?? ""; } catch { /* Storage can be unavailable. */ }
      set((state) => ({ drafts: { ...state.drafts, [key]: text } }));
    },
    setDraft: (key, text) => {
      try {
        if (text) storage().setItem(PREFIX + key, text);
        else storage().removeItem(PREFIX + key);
      } catch { /* Keep the unsent message in memory if disk storage fails. */ }
      set((state) => ({ drafts: { ...state.drafts, [key]: text } }));
    },
    moveDraft: (from, to) => {
      if (from === to) return;
      get().load(from);
      get().load(to);
      if (get().drafts[from]) get().setDraft(to, get().drafts[from]);
      get().setDraft(from, "");
    },
  }));
}

export const useChatDraftStore = createChatDraftStore(() => window.localStorage);
