import { create } from "zustand";

const STORAGE_KEY = "shep:chat-models";

interface RememberedModel {
  id: string;
  name: string;
}

interface ChatModelStore {
  models: Record<string, RememberedModel>;
  remember: (assistantId: string, model: RememberedModel) => void;
  useAgentDefault: (assistantId: string) => void;
}

type ModelStorage = Pick<Storage, "getItem" | "setItem">;

/** Separate from CLI preferences: these choices apply only to new Shep chats. */
export function createChatModelStore(storage: () => ModelStorage) {
  let models: ChatModelStore["models"] = {};
  try {
    const saved: unknown = JSON.parse(storage().getItem(STORAGE_KEY) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      models = Object.fromEntries(Object.entries(saved).filter(([, model]) =>
        model && typeof model === "object" && typeof model.id === "string" && model.id.trim() && typeof model.name === "string",
      ));
    }
  } catch { /* A missing or invalid preference falls back to agent defaults. */ }

  const save = (next: ChatModelStore["models"]) => {
    try { storage().setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { /* Keep the choice for this app session if storage is unavailable. */ }
  };

  return create<ChatModelStore>((set, get) => ({
    models,
    remember: (assistantId, model) => {
      const next = { ...get().models, [assistantId]: { ...model } };
      save(next);
      set({ models: next });
    },
    useAgentDefault: (assistantId) => {
      const next = { ...get().models };
      delete next[assistantId];
      save(next);
      set({ models: next });
    },
  }));
}

export const useChatModelStore = createChatModelStore(() => window.localStorage);
