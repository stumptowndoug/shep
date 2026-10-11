import { applySessionUpdate, type ChatState, type PlanEntry } from "./chatModel.ts";
import { clipText } from "./chatContent.ts";

export interface CursorQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple: boolean;
}
export type CursorRequest =
  | { kind: "question"; title: string; questions: CursorQuestion[] }
  | { kind: "plan"; title: string; overview: string; plan: string; todos: PlanEntry[] };
export type CursorOutcome =
  | { outcome: "answered"; answers: { questionId: string; selectedOptionIds: string[] }[] }
  | { outcome: "skipped" }
  | { outcome: "accepted" }
  | { outcome: "rejected" }
  | { outcome: "cancelled" };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Expected text of at most ${limit} characters`);
  return value;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Expected a list of at most ${limit} items`);
  return value;
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate choice or question ids");
}
function todos(value: unknown): PlanEntry[] {
  return list(value, 128).map(entry => {
    const todo = record(entry);
    if (!["pending", "in_progress", "completed", "cancelled"].includes(String(todo.status))) throw new Error("Unknown todo status");
    return { id: text(todo.id, 500), content: text(todo.content), status: todo.status as PlanEntry["status"] };
  });
}

/** Reject malformed/oversized approval content rather than approving a clipped plan. */
export function parseCursorRequest(method: string, params: unknown): CursorRequest | null {
  if (method !== "cursor/ask_question" && method !== "cursor/create_plan") return null;
  const value = record(params);
  if (method === "cursor/ask_question") {
    const questions = list(value.questions, 16).map(entry => {
      const question = record(entry);
      const options = list(question.options, 32).map(entry => {
        const option = record(entry);
        return { id: text(option.id, 500), label: text(option.label) };
      });
      if (!options.length) throw new Error("A question needs at least one option");
      unique(options.map(option => option.id));
      return { id: text(question.id, 500), prompt: text(question.prompt), options, allowMultiple: question.allowMultiple === true };
    });
    if (!questions.length) throw new Error("At least one question is required");
    unique(questions.map(question => question.id));
    return { kind: "question", title: value.title ? text(value.title) : "Cursor needs your input", questions };
  }
  return {
    kind: "plan", title: value.name ? text(value.name) : "Review Cursor’s plan",
    overview: value.overview ? text(value.overview) : "",
    plan: text(value.plan, 48_000), todos: todos(value.todos ?? []),
  };
}

export function validCursorOutcome(request: CursorRequest, response: CursorOutcome): boolean {
  if (response.outcome === "cancelled") return true;
  if (request.kind === "plan") return response.outcome === "accepted" || response.outcome === "rejected";
  if (response.outcome === "skipped") return true;
  if (response.outcome !== "answered" || response.answers.length !== request.questions.length) return false;
  return request.questions.every(question => {
    const answers = response.answers.filter(answer => answer.questionId === question.id);
    if (answers.length !== 1) return false;
    const selected = answers[0].selectedOptionIds;
    return selected.length > 0 && (question.allowMultiple || selected.length === 1) &&
      new Set(selected).size === selected.length && selected.every(id => question.options.some(option => option.id === id));
  });
}

export function applyCursorNotification(state: ChatState, method: string, params: unknown): ChatState {
  try {
    const value = record(params);
    if (method === "cursor/update_todos") {
      const next = todos(value.todos);
      let previous: PlanEntry[] = [];
      if (value.merge === true) {
        for (let i = state.turns.length - 1; i >= 0; i--) {
          const plan = state.turns[i].items.find(item => item.kind === "plan");
          if (plan?.kind === "plan") { previous = plan.entries; break; }
        }
      }
      const merged = new Map(previous.map(entry => [entry.id, entry]));
      for (const entry of next) merged.set(entry.id, entry);
      const entries = [...merged.values()];
      if (entries.length > 128) return state;
      return applySessionUpdate(state, { sessionUpdate: "plan", entries });
    }
    if (method === "cursor/task" || method === "cursor/generate_image") {
      const image = method === "cursor/generate_image";
      return applySessionUpdate(state, {
        sessionUpdate: "tool_call_update", toolCallId: text(value.toolCallId, 500), kind: "other", status: "completed",
        title: clipText(`${image ? "Generated image" : "Subagent"}: ${text(value.description)}`, 1000),
        rawOutput: image && typeof value.filePath === "string" ? clipText(value.filePath, 4000) : undefined,
      });
    }
  } catch { /* Ignore malformed optional notifications; blocking requests get explicit errors. */ }
  return state;
}
