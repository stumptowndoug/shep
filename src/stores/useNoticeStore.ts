import { create } from "zustand";

export type NoticeTone = "info" | "success" | "error";

export interface Notice {
  id: number;
  title: string;
  message?: string;
  tone: NoticeTone;
}

interface NoticeStore {
  notices: Notice[];
  pushNotice: (
    notice: Omit<Notice, "id">,
    options?: { durationMs?: number },
  ) => number;
  removeNotice: (id: number) => void;
}

let noticeCounter = 0;

export const useNoticeStore = create<NoticeStore>((set) => ({
  notices: [],

  pushNotice: (notice, options) => {
    const id = ++noticeCounter;
    const nextNotice: Notice = { id, ...notice };

    set((state) => ({ notices: [...state.notices, nextNotice] }));

    const durationMs = options?.durationMs ?? 3600;
    if (durationMs > 0) window.setTimeout(() => {
      set((state) => ({
        notices: state.notices.filter((entry) => entry.id !== id),
      }));
    }, durationMs);

    return id;
  },

  removeNotice: (id) => {
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
    }));
  },
}));
