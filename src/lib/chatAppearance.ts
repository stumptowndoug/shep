/**
 * Chat text font and size. Chat CSS is written against the app's type tokens at
 * their default sizes, so the chat root rescales those tokens instead of every
 * rule knowing about the setting. Code in chat uses the terminal font.
 */

/** Chat body text size at the default setting (`--text-base`). */
export const CHAT_FONT_SIZE = 15;
export const CHAT_FONT_SIZE_OPTIONS = [13, 14, 15, 16, 17, 18, 20] as const;

export interface ChatAppearance {
  /** Installed family name, or null for the system font. */
  fontFamily: string | null;
  /** Not a macOS font, so the webview needs it loaded from disk first. */
  loadFont: boolean;
  fontSize: number;
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { fontFamily: null, loadFont: false, fontSize: CHAT_FONT_SIZE };

export function parseChatAppearance(raw: string | null): ChatAppearance {
  if (!raw) return DEFAULT_CHAT_APPEARANCE;
  try {
    const value = JSON.parse(raw) as Partial<ChatAppearance>;
    const fontFamily = typeof value.fontFamily === "string" && value.fontFamily.trim() ? value.fontFamily.trim() : null;
    const fontSize = CHAT_FONT_SIZE_OPTIONS.includes(value.fontSize as never) ? value.fontSize! : CHAT_FONT_SIZE;
    return { fontFamily, loadFont: Boolean(fontFamily && value.loadFont), fontSize };
  } catch {
    return DEFAULT_CHAT_APPEARANCE;
  }
}

const quote = (family: string) => `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** CSS custom properties for the chat root; `codeFont` is a CSS font-family list. */
export function chatAppearanceStyle(appearance: ChatAppearance, codeFont: string): Record<string, string> {
  const style: Record<string, string> = {
    "--chat-scale": String(appearance.fontSize / CHAT_FONT_SIZE),
    "--chat-code-font": codeFont,
  };
  if (appearance.fontFamily) style["--chat-font"] = `${quote(appearance.fontFamily)}, ui-sans-serif, -apple-system, sans-serif`;
  return style;
}
