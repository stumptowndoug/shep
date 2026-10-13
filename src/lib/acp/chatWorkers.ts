import { applySessionUpdate, emptyChat, endTurn, lastOf, startTurn, type ChatState, type SessionUpdate } from "./chatModel.ts";

export type WorkerState = "running" | "completed" | "failed" | "cancelled" | "disconnected";

export interface ChatWorker {
  sessionId: string;
  parentSessionId: string;
  name: string;
  task: string;
  state: WorkerState;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastActivity: string | null;
  /** The root turn the agent was started in; nested agents share their parent's. */
  turnId?: number;
  chat: ChatState;
  transcriptTrimmed?: boolean;
}

/** Opt in to the subagent spawn/terminal events these adapters send.
 * Claude, Codex and Muse read the JetBrains AIR nativeSubagentSessions flag;
 * Cursor only reads `subagents`, which it also accepts under `_meta`.
 * Do not advertise the top-level draft `subagents` capability: its
 * reusable-session and directed-message contract differs from these events.
 * Keep the client identity Shep; only opt in to the extension we implement.
 */
export function workerCapabilities(assistantId: string) {
  if (assistantId === "claude" || assistantId === "codex" || assistantId === "muse") {
    return { _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } };
  }
  return assistantId === "cursor" ? { _meta: { subagents: true } } : {};
}

const TERMINAL_STATES = new Set<WorkerState>(["completed", "failed", "cancelled", "disconnected"]);
const text = (value: unknown, max = 1000) => typeof value === "string" ? value.slice(0, max) : "";

export function runningWorkers(chat: ChatState): ChatWorker[] {
  return (chat.workers ?? []).filter(worker => worker.state === "running");
}

/** Agents with an unanswered permission request, in request order. */
export function waitingWorkerIds(chat: ChatState): string[] {
  return [...new Set(chat.turns.flatMap(turn => turn.items).flatMap(item =>
    item.kind === "permission" && item.chosen === null && item.ownerSessionId ? [item.ownerSessionId] : [],
  ))];
}

/** Depth-first in spawn order, so a nested agent sits under the one that started it. */
export function workerTree(workers: ChatWorker[]): { worker: ChatWorker; depth: number }[] {
  const ids = new Set(workers.map(worker => worker.sessionId));
  const ordered: { worker: ChatWorker; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const worker of workers) {
      const isChild = parentId === null ? !ids.has(worker.parentSessionId) : worker.parentSessionId === parentId;
      if (!isChild) continue;
      ordered.push({ worker, depth });
      visit(worker.sessionId, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export function workerSummary(chat: ChatState): string | null {
  const workers = chat.workers ?? [];
  if (!workers.length) return null;
  const running = runningWorkers(chat).length;
  const waiting = waitingWorkerIds(chat).length;
  const unknown = workers.filter(worker => worker.state === "disconnected").length;
  const failed = workers.filter(worker => worker.state === "failed").length;
  return [
    running ? `${running} ${running === 1 ? "agent" : "agents"} running` : `${workers.length} ${workers.length === 1 ? "agent" : "agents"}`,
    waiting ? `${waiting} needs permission` : null,
    failed ? `${failed} failed` : null,
    unknown ? `${unknown} status unknown` : null,
  ].filter(Boolean).join(" · ");
}

/** Bound child transcripts independently of the main conversation. Keep the
 * newest 64 KiB of display payload and 100 items; never lose worker identity
 * or pending controls (which live in the root approval queue).
 */
function boundTranscript(worker: ChatWorker): ChatWorker {
  let budget = 64_000;
  let itemsLeft = 100;
  let trimmed = worker.transcriptTrimmed ?? false;
  const turns = worker.chat.turns.slice(-10).map(turn => ({ ...turn, items: [...turn.items] }));
  if (turns.length < worker.chat.turns.length) trimmed = true;
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    for (let i = turn.items.length - 1; i >= 0; i--) {
      let item = turn.items[i];
      if ((item.kind === "message" || item.kind === "thought") && item.text.length > 24_000) {
        item = { ...item, text: item.text.slice(-24_000) };
        turn.items[i] = item;
        trimmed = true;
      }
      // JSON length also covers images, diffs and rich content, not only text.
      const size = JSON.stringify(item).length;
      if (itemsLeft-- <= 0 || size > budget) {
        turn.items.splice(i, 1);
        trimmed = true;
      } else budget -= size;
    }
    if ((turn.prompt?.length ?? 0) > budget) { turn.prompt = null; trimmed = true; }
    else budget -= turn.prompt?.length ?? 0;
  }
  return { ...worker, transcriptTrimmed: trimmed, chat: { ...worker.chat, turns } };
}

function putWorker(chat: ChatState, next: ChatWorker): ChatState {
  const workers = chat.workers ?? [];
  const exists = workers.some(worker => worker.sessionId === next.sessionId);
  const updated = exists ? workers.map(worker => worker.sessionId === next.sessionId ? boundTranscript(next) : worker)
    : [...workers, boundTranscript(next)];
  // Retain summaries for all workers, but only the last 50 settled transcripts.
  const retained = new Set(updated.filter(worker => worker.state !== "running").slice(-50).map(worker => worker.sessionId));
  return { ...chat, workers: updated.map(worker => worker.state !== "running" && !retained.has(worker.sessionId) && worker.chat.turns.length
    ? { ...worker, chat: { ...worker.chat, turns: [] }, transcriptTrimmed: true } : worker) };
}

/** Route by connection-local session id. Unknown sessions never enter the
 * root transcript. Adapters announce children before any of their traffic.
 */
export function applyWorkerNotification(chat: ChatState, sessionId: string | undefined, update: SessionUpdate, now = Date.now()): ChatState {
  if (typeof update.sessionUpdate !== "string") return chat;
  const rootId = chat.acpSessionId ?? sessionId;
  const base = rootId && !chat.acpSessionId ? { ...chat, acpSessionId: rootId } : chat;
  const ownerId = sessionId ?? rootId;
  const owner = (base.workers ?? []).find(worker => worker.sessionId === ownerId);
  if (ownerId !== rootId && !owner) return base;

  if (update.sessionUpdate === "subagent_spawned") {
    const id = typeof update.subagentSessionId === "string" ? update.subagentSessionId : "";
    if (!id || id === rootId || !ownerId) return base;
    const existing = base.workers?.find(worker => worker.sessionId === id);
    // Repeated announcements enrich metadata; they cannot resurrect or reparent.
    if (existing && existing.parentSessionId !== ownerId) return base;
    const prompt = text(update.prompt, 24_000);
    return putWorker(base, existing ? {
      ...existing, name: text(update.name) || existing.name, task: text(update.task, 4000) || existing.task,
    } : {
      sessionId: id, parentSessionId: ownerId, name: text(update.name) || "Agent", task: text(update.task, 4000),
      state: "running", startedAt: now, updatedAt: now, endedAt: null, lastActivity: null,
      turnId: owner ? owner.turnId : lastOf(base.turns)?.id,
      chat: startTurn(emptyChat(), prompt || null),
    });
  }

  if (update.sessionUpdate === "subagent_state_update") {
    const worker = base.workers?.find(entry => entry.sessionId === update.subagentSessionId && entry.parentSessionId === ownerId);
    const state = update.state as WorkerState;
    if (!worker || !TERMINAL_STATES.has(state)) return base;
    return putWorker(base, { ...worker, state, updatedAt: now, endedAt: worker.endedAt ?? now,
      chat: endTurn(worker.chat, state === "completed" ? "end_turn" : state) });
  }

  if (!owner) return applySessionUpdate(base, update);
  let child = owner.chat;
  // Child metadata must never change the root's model, mode or access policy.
  if (update.sessionUpdate === "session_info_update") {
    return putWorker(base, { ...owner, name: text(update.title) || owner.name });
  }
  // The optional spawn prompt is a display prelude. Avoid duplicating its replay.
  if (update.sessionUpdate === "user_message_chunk" && child.turns.length === 1 && !child.turns[0].items.length &&
      child.turns[0].prompt === update.content?.text) return base;
  child = applySessionUpdate(child, update);
  const latest = lastOf(lastOf(child.turns)?.items ?? []);
  const activity = update.sessionUpdate.startsWith("tool_call") && typeof update.title === "string" ? text(update.title)
    : latest?.kind === "message" ? text(latest.text.replace(/\s+/g, " "), 180) : owner.lastActivity;
  // Late output updates the transcript, but only lifecycle events change state.
  return putWorker(base, { ...owner, chat: child, lastActivity: activity, updatedAt: now });
}

export function disconnectWorkers(chat: ChatState): ChatState {
  return { ...chat, workers: chat.workers?.map(worker => worker.state === "running"
    ? { ...worker, state: "disconnected", endedAt: Date.now(), chat: endTurn(worker.chat, "disconnected") } : worker) };
}
