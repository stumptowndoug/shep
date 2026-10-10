// Chat state for ACP sessions, and the pure reducer that folds the agent's
// `session/update` notifications into it.

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type ChatItem =
  | { kind: "message"; id: string; text: string; messageId: string | null }
  | { kind: "thought"; id: string; text: string; messageId: string | null }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: string;
      status: ToolStatus;
      output: string;
      diffs: ToolDiff[];
    }
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | {
      kind: "permission";
      id: string;
      title: string;
      options: PermissionOption[];
      chosen: string | null;
    }
  | { kind: "notice"; id: string; text: string };

export interface ChatTurn {
  id: number;
  prompt: string | null;
  items: ChatItem[];
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
}

/** A session setting the agent lets the user change (model, mode, effort). */
export interface ChatOption {
  id: string;
  name: string;
  value: string;
  choices: { value: string; name: string }[];
  /** Which ACP method changes it. */
  source: "config" | "mode" | "model";
}

export interface ChatCommand {
  name: string;
  description: string;
}

export type ChatStatus = "starting" | "ready" | "working" | "exited";

export interface ChatState {
  status: ChatStatus;
  turns: ChatTurn[];
  options: ChatOption[];
  commands: ChatCommand[];
  queued: string[];
  error: string | null;
  /** Context window use, when the agent reports it. */
  usage: { used: number; size: number } | null;
}

export function lastOf<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

export function emptyChat(): ChatState {
  return { status: "starting", turns: [], options: [], commands: [], queued: [], error: null, usage: null };
}

// ── Turns ────────────────────────────────────────────────────────────

export function startTurn(state: ChatState, prompt: string | null): ChatState {
  const turn: ChatTurn = {
    id: state.turns.length,
    prompt,
    items: [],
    startedAt: Date.now(),
    endedAt: null,
    stopReason: null,
  };
  return { ...state, turns: [...state.turns, turn] };
}

export function endTurn(state: ChatState, stopReason: string): ChatState {
  const turn = lastOf(state.turns);
  if (!turn || turn.endedAt !== null) return state;
  return replaceLastTurn(state, { ...turn, endedAt: Date.now(), stopReason });
}

function replaceLastTurn(state: ChatState, turn: ChatTurn): ChatState {
  return { ...state, turns: [...state.turns.slice(0, -1), turn] };
}

/** Apply `fn` to the current turn's items, opening a turn if none is open. */
function updateItems(state: ChatState, fn: (items: ChatItem[]) => ChatItem[]): ChatState {
  const base = lastOf(state.turns)?.endedAt === null ? state : startTurn(state, null);
  const turn = lastOf(base.turns)!;
  return replaceLastTurn(base, { ...turn, items: fn(turn.items) });
}

let itemCounter = 0;
const nextItemId = () => `item-${++itemCounter}`;

export function addNotice(state: ChatState, text: string): ChatState {
  return updateItems(state, (items) => [...items, { kind: "notice", id: nextItemId(), text }]);
}

export function addPermission(
  state: ChatState,
  id: string,
  title: string,
  options: PermissionOption[],
): ChatState {
  return updateItems(state, (items) => [
    ...items,
    { kind: "permission", id, title, options, chosen: null },
  ]);
}

export function resolvePermission(state: ChatState, id: string, optionId: string | null): ChatState {
  return {
    ...state,
    turns: state.turns.map((turn) =>
      turn.items.some((item) => item.id === id)
        ? {
            ...turn,
            items: turn.items.map((item) =>
              item.kind === "permission" && item.id === id
                ? { ...item, chosen: optionId ?? "cancelled" }
                : item,
            ),
          }
        : turn,
    ),
  };
}

export function pendingPermission(state: ChatState) {
  const items = lastOf(state.turns)?.items ?? [];
  return items.find(
    (item): item is Extract<ChatItem, { kind: "permission" }> =>
      item.kind === "permission" && item.chosen === null,
  );
}

// ── Session updates ──────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface ToolCallContent {
  type: "content" | "diff" | "terminal";
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

interface SessionUpdate {
  sessionUpdate: string;
  content?: ContentBlock;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: ToolStatus;
  locations?: { path: string }[];
  rawInput?: { command?: string | string[] };
  [key: string]: unknown;
}

function appendText(
  state: ChatState,
  kind: "message" | "thought",
  text: string,
  messageId: string | null,
): ChatState {
  if (!text) return state;
  return updateItems(state, (items) => {
    const last = lastOf(items);
    const sameMessage = last?.kind === kind && (!messageId || !last.messageId || last.messageId === messageId);
    if (sameMessage) {
      return [...items.slice(0, -1), { ...last, text: last.text + text, messageId: last.messageId ?? messageId }];
    }
    return [...items, { kind, id: nextItemId(), text, messageId }];
  });
}

function toolOutput(content: ToolCallContent[] | undefined): string {
  return (content ?? [])
    .filter((entry) => entry.type === "content" && entry.content?.type === "text")
    .map((entry) => entry.content!.text ?? "")
    .join("\n");
}

function toolDiffs(content: ToolCallContent[] | undefined): ToolDiff[] {
  return (content ?? [])
    .filter((entry) => entry.type === "diff" && entry.path)
    .map((entry) => ({
      path: entry.path!,
      oldText: entry.oldText ?? null,
      newText: entry.newText ?? "",
    }));
}

function toolCommand(update: SessionUpdate): string | null {
  const command = update.rawInput?.command;
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : null;
}

/** Some agents title a call with just its kind ("read"); prefer the target. */
function toolTitle(update: SessionUpdate, previous: string | undefined): string | undefined {
  const title = update.title?.trim();
  const generic = !title || title.toLowerCase() === (update.kind ?? "").toLowerCase();
  if (!generic) return title;
  const path = update.locations?.[0]?.path;
  return toolCommand(update) ?? (path ? path.split("/").pop() : undefined) ?? previous ?? title;
}

function upsertTool(state: ChatState, update: SessionUpdate): ChatState {
  const id = `tool-${update.toolCallId}`;
  const content = update.content as ToolCallContent[] | undefined;
  return updateItems(state, (items) => {
    const index = items.findIndex((item) => item.id === id);
    const existing = index === -1 ? null : items[index];
    const previous = existing?.kind === "tool" ? existing : null;
    const output = toolOutput(content);
    const diffs = toolDiffs(content);
    const next: ChatItem = {
      kind: "tool",
      id,
      title: toolTitle(update, previous?.title) ?? "Tool call",
      toolKind: update.kind ?? previous?.toolKind ?? "other",
      status: update.status ?? previous?.status ?? "pending",
      output: output || (previous?.output ?? ""),
      diffs: diffs.length ? diffs : previous?.diffs ?? [],
    };
    if (index === -1) return [...items, next];
    const copy = [...items];
    copy[index] = next;
    return copy;
  });
}

function upsertPlan(state: ChatState, entries: PlanEntry[]): ChatState {
  return updateItems(state, (items) => {
    const index = items.findIndex((item) => item.kind === "plan");
    const plan: ChatItem = { kind: "plan", id: index === -1 ? nextItemId() : items[index].id, entries };
    if (index === -1) return [...items, plan];
    const copy = [...items];
    copy[index] = plan;
    return copy;
  });
}

export function applySessionUpdate(state: ChatState, update: SessionUpdate): ChatState {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      // Replayed history from session/load: each user message opens a turn.
      const text = update.content?.type === "text" ? update.content.text ?? "" : "";
      const last = lastOf(state.turns);
      if (last && last.endedAt === null && last.items.length === 0 && last.prompt !== null) {
        return replaceLastTurn(state, { ...last, prompt: last.prompt + text });
      }
      const closed = last ? endTurn(state, "end_turn") : state;
      return startTurn(closed, text);
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content?.type !== "text") return state;
      const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
      return appendText(state, kind, update.content.text ?? "", update.messageId ?? null);
    }
    case "tool_call":
    case "tool_call_update":
      return update.toolCallId ? upsertTool(state, update) : state;
    case "plan":
      return upsertPlan(state, (update.entries as PlanEntry[] | undefined) ?? []);
    case "available_commands_update":
      return {
        ...state,
        commands: ((update.availableCommands as ChatCommand[] | undefined) ?? []).map((command) => ({
          name: command.name,
          description: command.description ?? "",
        })),
      };
    case "usage_update": {
      const used = update.used as number | undefined;
      const size = update.size as number | undefined;
      return typeof used === "number" && typeof size === "number" && size > 0
        ? { ...state, usage: { used, size } }
        : state;
    }
    case "current_mode_update":
      return setOptionValue(state, "mode", update.currentModeId as string);
    case "config_option_update":
    case "config_options_update": {
      const configOptions = update.configOptions as AcpConfigOption[] | undefined;
      return configOptions ? { ...state, options: optionsFromSession({ configOptions }) } : state;
    }
    default:
      return state;
  }
}

// ── Session options ──────────────────────────────────────────────────

interface AcpConfigOption {
  id: string;
  name: string;
  type: string;
  category?: string;
  currentValue: string;
  options?: { value: string; name: string }[];
}

export interface AcpSessionInfo {
  configOptions?: AcpConfigOption[];
  modes?: { currentModeId: string; availableModes: { id: string; name: string }[] } | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null;
}

/**
 * Normalize the agent's adjustable settings. Newer agents expose everything
 * as `configOptions`; older ones use the separate `modes`/`models` fields.
 */
export function optionsFromSession(session: AcpSessionInfo): ChatOption[] {
  const options: ChatOption[] = (session.configOptions ?? [])
    .filter((option) => option.type === "select" && option.options?.length)
    .map((option) => ({
      id: option.id,
      name: option.name,
      value: option.currentValue,
      choices: option.options!,
      source: "config" as const,
    }));
  const has = (id: string) => options.some((option) => option.id === id);

  if (session.models?.availableModels.length && !has("model")) {
    options.unshift({
      id: "model",
      name: "Model",
      value: session.models.currentModelId,
      choices: session.models.availableModels.map((model) => ({ value: model.modelId, name: model.name })),
      source: "model",
    });
  }
  if (session.modes?.availableModes.length && !has("mode")) {
    options.push({
      id: "mode",
      name: "Mode",
      value: session.modes.currentModeId,
      choices: session.modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      source: "mode",
    });
  }
  return options;
}

export function setOptionValue(state: ChatState, id: string, value: string): ChatState {
  if (!state.options.some((option) => option.id === id)) return state;
  return {
    ...state,
    options: state.options.map((option) => (option.id === id ? { ...option, value } : option)),
  };
}
