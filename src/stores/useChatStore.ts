import { create } from "zustand";
import { emptyChat, type ChatState } from "../lib/acp/chatModel";

interface ChatStore {
  chats: Record<number, ChatState>;
  init: (id: number) => void;
  update: (id: number, fn: (chat: ChatState) => ChatState) => void;
  remove: (id: number) => void;
}

/** Conversation state for ACP chat tabs, keyed by the tab's session id. */
export const useChatStore = create<ChatStore>((set) => ({
  chats: {},

  init: (id) => set((state) => ({ chats: { ...state.chats, [id]: emptyChat() } })),

  update: (id, fn) =>
    set((state) => {
      const chat = state.chats[id];
      if (!chat) return state;
      const next = fn(chat);
      return next === chat ? state : { chats: { ...state.chats, [id]: next } };
    }),

  remove: (id) =>
    set((state) => {
      const { [id]: _, ...chats } = state.chats;
      return { chats };
    }),
}));
