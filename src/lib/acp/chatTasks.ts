import { lastOf, type ChatState, type SessionUpdate } from "./chatModel.ts";

/** Claude and Codex report `running`, `completed`, `failed` and `stopped`;
 * `disconnected` is Shep's own, for a task whose agent went away. */
export type TaskState = "running" | "completed" | "failed" | "stopped" | "disconnected" | (string & {});

/** Work the agent left running after a tool call returned: a backgrounded
 * command, as Claude's and Codex's adapters report it (`async_task_*`). */
export interface ChatTask {
  id: string;
  /** The delegated agent that started it; absent for the chat's own agent. */
  ownerSessionId?: string;
  name: string;
  description: string;
  taskType: string;
  /** The tool call that started it. Codex streams the command's output there. */
  toolCallId?: string;
  summary?: string;
  canStop: boolean;
  /** Where Claude writes the command's output. */
  outputFile?: string;
  state: TaskState;
  startedAt: number;
  endedAt: number | null;
  /** The turn the task sits in: its tool call's, or the one running when it started. */
  turnId?: number;
}

const MAX_TASKS = 100;
const text = (value: unknown, max = 1000) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function runningTasks(chat: ChatState): ChatTask[] {
  return (chat.tasks ?? []).filter(task => task.state === "running");
}

export function taskTitle(task: ChatTask): string {
  return task.description || task.name || "Background task";
}

/** The turn holding a tool call, in the chat or in the delegated agent that made it. */
function taskTurn(chat: ChatState, ownerSessionId: string | undefined, toolCallId: string | undefined): number | undefined {
  if (ownerSessionId) return chat.workers?.find(worker => worker.sessionId === ownerSessionId)?.turnId;
  const itemId = `tool-${toolCallId}`;
  if (toolCallId) {
    for (let index = chat.turns.length - 1; index >= 0; index--) {
      if (chat.turns[index].items.some(item => item.id === itemId)) return chat.turns[index].id;
    }
  }
  return lastOf(chat.turns)?.id;
}

/** Fold `async_task_spawned` / `async_task_state_update` into the chat. Tasks
 * are keyed by the session that owns them; an update for a task that was never
 * announced is ignored. */
export function applyTaskUpdate(chat: ChatState, ownerSessionId: string | undefined, update: SessionUpdate, now = Date.now()): ChatState {
  const id = text(update.asyncTaskId, 200);
  if (!id) return chat;
  const tasks = chat.tasks ?? [];
  const existing = tasks.find(task => task.id === id && task.ownerSessionId === ownerSessionId);
  if (!existing && update.sessionUpdate !== "async_task_spawned") return chat;
  const toolCallId = text(update.toolCallId, 200) || existing?.toolCallId;
  const outputFile = typeof update.outputFilePath === "string" && update.outputFilePath.startsWith("/") ? update.outputFilePath : existing?.outputFile;
  const state = update.sessionUpdate === "async_task_state_update" ? text(update.state, 40) || existing?.state : existing?.state;
  const next: ChatTask = {
    id,
    ...(ownerSessionId ? { ownerSessionId } : {}),
    name: text(update.name) || existing?.name || "",
    description: text(update.description, 4000) || existing?.description || "",
    taskType: text(update.taskType, 40) || existing?.taskType || "task",
    ...(toolCallId ? { toolCallId } : {}),
    ...(text(update.summary, 4000) || existing?.summary ? { summary: text(update.summary, 4000) || existing?.summary } : {}),
    canStop: typeof update.canStop === "boolean" ? update.canStop : existing?.canStop ?? false,
    ...(outputFile ? { outputFile } : {}),
    state: state || "running",
    startedAt: existing?.startedAt ?? now,
    endedAt: !state || state === "running" || state === "paused" ? null : existing?.endedAt ?? now,
    turnId: existing?.turnId ?? taskTurn(chat, ownerSessionId, toolCallId),
  };
  // Announced again: better details, but a settled task stays settled.
  if (existing && existing.state !== "running" && next.state === "running") return chat;
  const updated = existing ? tasks.map(task => task === existing ? next : task) : [...tasks, next];
  // Keep every running task, and the newest settled ones.
  const settled = updated.filter(task => task.state !== "running");
  const drop = new Set(settled.slice(0, Math.max(0, updated.length - MAX_TASKS)));
  return { ...chat, tasks: updated.filter(task => !drop.has(task)) };
}

/** The agent went away: whatever it left running has no known outcome. */
export function disconnectTasks(chat: ChatState): ChatState {
  if (!chat.tasks?.some(task => task.state === "running")) return chat;
  return { ...chat, tasks: chat.tasks.map(task => task.state === "running" ? { ...task, state: "disconnected", endedAt: Date.now() } : task) };
}

/** What's still running beside the conversation: background commands and delegated agents. */
export function backgroundWork(chat: ChatState | undefined): { tasks: number; agents: number } {
  return {
    tasks: chat ? runningTasks(chat).length : 0,
    agents: chat?.workers?.filter(worker => worker.state === "running").length ?? 0,
  };
}

/** "2 background commands and 1 agent", or null when nothing is running. */
export function backgroundWorkLabel({ tasks, agents }: { tasks: number; agents: number }): string | null {
  const parts = [
    tasks ? `${tasks} background ${tasks === 1 ? "command" : "commands"}` : null,
    agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}
