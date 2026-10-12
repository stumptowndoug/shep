import { openUrl, readChatImage, revealInFinder } from "../../lib/tauri";
import { chatImageErrorMessage, resolveImagePath } from "../../lib/acp/chatImages";
import { getErrorMessage } from "../../lib/errors";
import { useNoticeStore } from "../../stores/useNoticeStore";

const notifyError = (title: string, error: unknown) =>
  useNoticeStore.getState().pushNotice({ tone: "error", title, message: getErrorMessage(error) });

const MAX_CACHED_IMAGES = 24;
// Bytes by project + path, so re-renders (streaming → highlighted) don't re-read files.
const imageCache = new Map<string, Promise<Blob>>();

function loadImage(path: string, baseDir: string): Promise<Blob> {
  const key = `${baseDir}\0${path}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const load = readChatImage(path, baseDir).then((bytes) => new Blob([bytes]));
  imageCache.set(key, load);
  // A missing file may appear later; don't remember failures.
  load.catch(() => imageCache.delete(key));
  while (imageCache.size > MAX_CACHED_IMAGES) imageCache.delete(imageCache.keys().next().value!);
  return load;
}

/** Swap local image placeholders for the real images. Returns a cleanup. */
export function hydrateChatImages(root: HTMLElement, baseDir: string): () => void {
  let disposed = false;
  const urls: string[] = [];
  for (const placeholder of root.querySelectorAll<HTMLElement>(".chat-image--local[data-path]")) {
    const path = placeholder.dataset.path!;
    loadImage(path, baseDir).then((blob) => {
      if (disposed || !placeholder.isConnected) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement("img");
      img.className = "chat-image__img";
      img.src = url;
      img.alt = placeholder.dataset.alt ?? "";
      img.title = `${path} — click to open`;
      img.dataset.path = path;
      placeholder.replaceWith(img);
    }, (error: unknown) => {
      if (disposed || !placeholder.isConnected) return;
      const code = getErrorMessage(error);
      placeholder.classList.add("chat-image--failed");
      const note = document.createElement("span");
      note.className = "chat-image__note";
      note.textContent = chatImageErrorMessage(code);
      placeholder.append(note);
      placeholder.title = `${path}\n${chatImageErrorMessage(code)}`;
      // It exists but can't be shown inline: let the user open it in Preview.
      if (code !== "missing" && resolveImagePath(path, baseDir)) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "chat-image__open";
        open.textContent = "Open";
        open.dataset.path = path;
        placeholder.append(open);
      }
    });
  }
  return () => {
    disposed = true;
    for (const url of urls) URL.revokeObjectURL(url);
  };
}

function openLocal(path: string, baseDir: string) {
  const resolved = resolveImagePath(path, baseDir);
  if (!resolved) return;
  void revealInFinder(resolved).catch((error) => notifyError("Couldn’t open file", error));
}

/**
 * The webview won't open links itself. Web links go to the browser, file links
 * and images open on the Mac.
 */
export function handleChatMarkdownClick(event: React.MouseEvent<HTMLElement>, baseDir: string) {
  const target = event.target as HTMLElement;
  const local = target.closest<HTMLElement>(".chat-image__img[data-path], .chat-image__open[data-path]");
  if (local) {
    event.preventDefault();
    openLocal(local.dataset.path!, baseDir);
    return;
  }
  const link = target.closest("a");
  const href = link?.getAttribute("href");
  if (!link || !href) return;
  event.preventDefault();
  if (/^file:\/\//i.test(href)) {
    openLocal(decodeURI(href), baseDir);
    return;
  }
  if (href.startsWith("#")) return;
  void openUrl(link.href).catch((error) => notifyError("Couldn’t open link", error));
}
