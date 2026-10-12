import { create } from "zustand";
import { parseChatAppearance, type ChatAppearance } from "../lib/chatAppearance";
import { ensureFamilyLoaded } from "../lib/fontLoader";

// A display preference like the theme, so it lives with the theme in local storage.
const STORAGE_KEY = "shep:chat-appearance";

function loadAppearance(): ChatAppearance {
  try {
    return parseChatAppearance(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseChatAppearance(null);
  }
}

function saveAppearance(appearance: ChatAppearance): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch { /* ignore */ }
}

/** macOS fonts work by name; fonts the user installed have to be loaded first. */
function loadFont(appearance: ChatAppearance): void {
  if (appearance.fontFamily && appearance.loadFont) void ensureFamilyLoaded(appearance.fontFamily);
}

interface ChatAppearanceStore {
  appearance: ChatAppearance;
  setFont: (family: string | null, isSystem: boolean) => void;
  setFontSize: (size: number) => void;
}

const initialAppearance = loadAppearance();
loadFont(initialAppearance);

export const useChatAppearanceStore = create<ChatAppearanceStore>((set, get) => {
  const update = (partial: Partial<ChatAppearance>) => {
    const appearance = { ...get().appearance, ...partial };
    saveAppearance(appearance);
    set({ appearance });
  };
  return {
    appearance: initialAppearance,
    setFont: (family, isSystem) => {
      const partial = { fontFamily: family, loadFont: Boolean(family) && !isSystem };
      loadFont({ ...get().appearance, ...partial });
      update(partial);
    },
    setFontSize: (fontSize) => update({ fontSize }),
  };
});
