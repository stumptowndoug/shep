import { create } from "zustand";
import { buildCustomTheme } from "../lib/customThemes";
import { DEFAULT_THEME_ID, THEMES, withLayeredSurfaces } from "../lib/themes";
import type { ShepTheme } from "../lib/themes";

const THEME_ID_STORAGE_KEY = "shep:theme";
const CUSTOM_THEME_STORAGE_KEY = "shep:custom-theme";

function isThemeRecord(value: unknown): value is ShepTheme {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.appBg === "string"
    && typeof candidate.appFg === "string"
    && typeof candidate.termForeground === "string";
}

function loadThemeId(): string {
  try {
    return window.localStorage.getItem(THEME_ID_STORAGE_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function loadCustomTheme(): ShepTheme | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isThemeRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveThemeId(id: string): void {
  try {
    window.localStorage.setItem(THEME_ID_STORAGE_KEY, id);
  } catch { /* ignore */ }
}

function saveCustomTheme(theme: ShepTheme): void {
  try {
    window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch { /* ignore */ }
}

function resolveTheme(id: string, customTheme: ShepTheme | null): ShepTheme {
  const base = id === customTheme?.id ? customTheme : THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
  return withLayeredSurfaces(base);
}

interface ThemeStore {
  themeId: string;
  theme: ShepTheme;
  customTheme: ShepTheme | null;
  setTheme: (id: string) => void;
  importTheme: (source: string) => ShepTheme;
}

const initialCustomTheme = loadCustomTheme();
const initialId = loadThemeId();
const initialTheme = resolveTheme(initialId, initialCustomTheme);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themeId: initialTheme.id,
  theme: initialTheme,
  customTheme: initialCustomTheme,
  setTheme: (id: string) => {
    const theme = resolveTheme(id, get().customTheme);
    saveThemeId(theme.id);
    set({ themeId: theme.id, theme });
  },
  importTheme: (source: string) => {
    const imported = buildCustomTheme(source);
    saveCustomTheme(imported);
    saveThemeId(imported.id);
    set({
      customTheme: imported,
      themeId: imported.id,
      theme: withLayeredSurfaces(imported),
    });
    return imported;
  },
}));
