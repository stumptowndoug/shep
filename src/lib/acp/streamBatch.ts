interface TextUpdate {
  sessionUpdate: string;
  messageId?: string;
  content: { type: "text"; text: string };
  [key: string]: unknown;
}

/** Coalesce tokens before publishing to React. Lifecycle boundaries explicitly flush. */
export function createStreamBatch(publish: (updates: TextUpdate[]) => void) {
  let pending: TextUpdate[] = [];
  let characters = 0;
  let frame: number | undefined;
  let timer: number | undefined;

  const discard = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (timer !== undefined) window.clearTimeout(timer);
    frame = timer = undefined;
    pending = [];
    characters = 0;
  };
  const flush = () => {
    const updates = pending;
    discard();
    if (updates.length) publish(updates);
  };
  return {
    flush,
    discard,
    enqueue(update: TextUpdate) {
      if (!update.content.text) return;
      const previous = pending[pending.length - 1];
      if (previous?.sessionUpdate === update.sessionUpdate && previous.messageId === update.messageId) {
        previous.content.text += update.content.text;
        previous.messageId ??= update.messageId;
      } else {
        pending.push({ ...update, content: { ...update.content } });
      }
      characters += update.content.text.length;
      // A suspended animation clock must not retain an unbounded token queue.
      if (characters >= 64_000 || pending.length >= 256) flush();
      else if (frame === undefined) {
        frame = window.requestAnimationFrame(flush);
        timer = window.setTimeout(flush, 100);
      }
    },
  };
}
