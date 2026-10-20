interface TextUpdate {
  sessionUpdate: string;
  messageId?: string;
  content: { type: "text"; text: string };
  [key: string]: unknown;
}

/** More of a running command's output (`_meta.terminal_output_delta`). */
interface OutputUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  routeSessionId?: string;
  _meta: { terminal_output_delta: { data: string; [key: string]: unknown } };
  [key: string]: unknown;
}

type StreamUpdate = TextUpdate | OutputUpdate;

const isOutput = (update: StreamUpdate | undefined): update is OutputUpdate => update?.sessionUpdate === "tool_call_update";

/** Coalesce tokens and command output before publishing to React. Lifecycle boundaries explicitly flush. */
export function createStreamBatch(publish: (updates: StreamUpdate[]) => void) {
  let pending: StreamUpdate[] = [];
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
  const schedule = (size: number) => {
    characters += size;
    // A suspended animation clock must not retain an unbounded token queue.
    if (characters >= 64_000 || pending.length >= 256) flush();
    else if (frame === undefined) {
      frame = window.requestAnimationFrame(flush);
      timer = window.setTimeout(flush, 100);
    }
  };
  return {
    flush,
    discard,
    enqueue(update: TextUpdate) {
      if (!update.content.text) return;
      const previous = pending[pending.length - 1];
      if (previous && !isOutput(previous) && previous.sessionUpdate === update.sessionUpdate && previous.messageId === update.messageId && previous.routeSessionId === update.routeSessionId) {
        previous.content.text += update.content.text;
        previous.messageId ??= update.messageId;
      } else {
        pending.push({ ...update, content: { ...update.content } });
      }
      schedule(update.content.text.length);
    },
    enqueueOutput(update: OutputUpdate) {
      const data = update._meta.terminal_output_delta.data;
      if (!data) return;
      const previous = pending[pending.length - 1];
      if (isOutput(previous) && previous.toolCallId === update.toolCallId && previous.routeSessionId === update.routeSessionId) {
        previous._meta.terminal_output_delta.data += data;
      } else {
        pending.push({ ...update, _meta: { terminal_output_delta: { ...update._meta.terminal_output_delta } } });
      }
      schedule(data.length);
    },
  };
}
