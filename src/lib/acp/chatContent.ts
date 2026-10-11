/** Bounds apply before content enters conversation state or expensive renderers. */
export const MAX_TOOL_TEXT = 24_000;
export const MAX_DIFF_TEXT = 24_000;
export const MAX_TOOL_DIFFS = 8;
export const MAX_IMAGE_DATA = 4 * 1024 * 1024;

export function clipText(text: string, limit = MAX_TOOL_TEXT, tail = false): string {
  if (text.length <= limit) return text;
  const note = "\n… [truncated]\n";
  const size = Math.max(0, limit - note.length);
  return tail ? note + text.slice(-size) : text.slice(0, size) + note;
}

/** Never stringify the complete raw payload just to shorten it afterwards. */
export function rawText(raw: unknown): string {
  let budget = MAX_TOOL_TEXT;
  const visit = (value: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 5) return "…";
    if (typeof value === "string") {
      const text = clipText(value, Math.max(32, budget), true);
      budget -= text.length;
      return text;
    }
    if (!value || typeof value !== "object") { budget -= 16; return value; }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (budget <= 0 || result.length >= 64) { result.push("…"); break; }
        result.push(visit(item, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (budget <= 0 || count++ >= 64) { result["…"] = "truncated"; break; }
      const shortKey = clipText(key, 160);
      budget -= shortKey.length;
      Object.defineProperty(result, shortKey, { value: visit((value as Record<string, unknown>)[key], depth + 1), enumerable: true, configurable: true });
    }
    return result;
  };
  return typeof raw === "string" ? clipText(raw, MAX_TOOL_TEXT, true) : clipText(JSON.stringify(visit(raw, 0), null, 2) ?? "", MAX_TOOL_TEXT, true);
}

export function rawToolOutput(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const streams = [value.stdout, value.stderr].filter((text): text is string => typeof text === "string" && text.length > 0);
    if (streams.length) return clipText(streams.map((text) => clipText(text, MAX_TOOL_TEXT, true)).join("\n"), MAX_TOOL_TEXT, true);
    const output = value.formatted_output ?? value.aggregated_output ?? value.output;
    if (output !== undefined) return rawText(output);
  }
  return raw == null ? "" : rawText(raw);
}

export type AgentMedia =
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name: string };

export function agentMedia(content: Record<string, unknown>): AgentMedia | null {
  if (content.type === "image" && typeof content.mimeType === "string" && /^image\/[\w.+-]+$/i.test(content.mimeType) &&
    typeof content.data === "string" && content.data.length > 0 && content.data.length <= MAX_IMAGE_DATA &&
    content.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(content.data)) {
    return { type: "image", mimeType: content.mimeType, data: content.data };
  }
  if (content.type === "resource_link" && typeof content.uri === "string" && content.uri.length <= 8192) {
    try {
      const url = new URL(content.uri);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return { type: "resource_link", uri: url.href, name: clipText(typeof content.name === "string" && content.name.trim() ? content.name : url.href, 500) };
    } catch { /* Ignore unsupported or malformed links. */ }
  }
  return null;
}
