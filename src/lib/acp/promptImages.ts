// Images the user pastes, drops or picks into the chat composer, prepared as
// ACP image blocks: formats every agent model reads, at a size they accept.
import type { PromptImage } from "./chatModel.ts";

export const MAX_PROMPT_IMAGES = 6;
/** Longest edge sent; larger images cost more and gain little for a model. */
export const MAX_IMAGE_EDGE = 2000;
/** Under the ~5 MB per-image ceiling providers enforce on base64 payloads. */
export const MAX_IMAGE_BYTES = 3_750_000;
const SENDABLE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The size to draw an image at so its longest edge fits, or null to keep it. */
export function fittedSize(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } | null {
  const scale = maxEdge / Math.max(width, height);
  if (scale >= 1) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Image files among pasted or dropped items, in order. */
export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter(file => file.type.startsWith("image/"));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn’t read the image."));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn’t encode the image.")), type, quality));
}

/** Read an image file, scaling and re-encoding only when it is too big or an unsendable format. */
export async function promptImageFromFile(file: File): Promise<PromptImage> {
  const name = file.name || undefined;
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name || "That file"} isn’t an image Shep can read.`); });
  try {
    const size = fittedSize(bitmap.width, bitmap.height);
    if (!size && SENDABLE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES) {
      return { mimeType: file.type, data: await base64(file), name };
    }
    const canvas = document.createElement("canvas");
    canvas.width = size?.width ?? bitmap.width;
    canvas.height = size?.height ?? bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // PNG keeps screenshot text crisp; fall back to JPEG for large photos.
    let blob = await canvasBlob(canvas, "image/png");
    if (blob.size > MAX_IMAGE_BYTES) blob = await canvasBlob(canvas, "image/jpeg", 0.88);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || "That image"} is too large to send.`);
    return { mimeType: blob.type, data: await base64(blob), name };
  } finally {
    bitmap.close();
  }
}
