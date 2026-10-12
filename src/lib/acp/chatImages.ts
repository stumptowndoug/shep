/**
 * Images in agent replies. The webview can't load local paths and the CSP blocks
 * remote images, so Markdown images render as placeholders: local files are read
 * through the backend and swapped in; remote images stay links (no tracking loads).
 */

export type ChatImageSource =
  | { kind: "inline"; src: string }
  | { kind: "remote"; src: string }
  | { kind: "local"; path: string };

export function classifyImageSource(src: string): ChatImageSource {
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return { kind: "inline", src };
  if (/^https?:/i.test(src)) return { kind: "remote", src };
  let path = src;
  try {
    path = decodeURI(src);
  } catch { /* keep as written */ }
  return { kind: "local", path };
}

export type ChatImageError = "missing" | "too-large" | "unsupported";

export function chatImageErrorMessage(code: string): string {
  if (code === "missing") return "Image not found";
  if (code === "too-large") return "Image is larger than 10 MB";
  return "Can't show this image here";
}

const IMAGE_ICON =
  '<svg class="chat-image__icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

/** HTML for a Markdown image; `escape` is markdown-it's escapeHtml. */
export function chatImageHtml(src: string, alt: string, escape: (value: string) => string): string {
  const source = classifyImageSource(src);
  const label = escape(alt.trim() || "Image");
  if (source.kind === "inline") {
    return `<img class="chat-image__img" src="${escape(source.src)}" alt="${escape(alt)}">`;
  }
  if (source.kind === "remote") {
    return `<a class="chat-image chat-image--link" href="${escape(source.src)}" title="${escape(source.src)}">${IMAGE_ICON}<span class="chat-image__label">${label}</span></a>`;
  }
  return `<span class="chat-image chat-image--local" data-path="${escape(source.path)}" data-alt="${escape(alt)}" title="${escape(source.path)}">${IMAGE_ICON}<span class="chat-image__label">${label}</span></span>`;
}

/** Where to find a referenced file for "Open", or null if we can't tell (e.g. `~/`). */
export function resolveImagePath(path: string, baseDir: string): string | null {
  const plain = path.replace(/^file:\/\//i, "");
  if (plain.startsWith("/")) return plain;
  if (plain.startsWith("~")) return null;
  return `${baseDir.replace(/\/+$/, "")}/${plain.replace(/^\.\//, "")}`;
}
