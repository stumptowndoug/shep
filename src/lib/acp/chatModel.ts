// Chat state for ACP sessions, and the pure reducer that folds the agent's
// `session/update` notifications into it.
import { agentMedia, clipText, MAX_DIFF_TEXT, MAX_TOOL_DIFFS, MAX_TOOL_TEXT, rawToolOutput, type AgentMedia } from "./chatContent.ts";
import type { CursorOutcome, CursorRequest } from "./cursorProtocol.ts";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
  truncated?: boolean;
}

export interface PlanEntry {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type ChatItem =
  | { kind: "message"; id: string; text: string; messageId: string | null }
  | { kind: "thought"; id: string; text: string; messageId: string | null }
  | { kind: "media"; id: string; content: AgentMedia }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: string;
      status: ToolStatus;
      output: string;
      diffs: ToolDiff[];
      omittedDiffs?: number;
    }
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "cursor_request"; id: string; request: CursorRequest; outcome: CursorOutcome | null }
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
  error?: string | null;
}

/** A session setting the agent lets the user change (model, mode, effort). */
export interface ChatOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  value: string;
  choices: { value: string; name: string; description?: string }[];
  /** Which ACP method changes it. */
  source: "config" | "mode" | "model";
}

export interface ChatCommand {
  name: string;
  description: string;
}

export type ChatStatus = "starting" | "ready" | "working" | "exited";

export interface SessionNotice {
  id: string;
  severity: string;
  title: string;
  description: string | null;
}

export interface ChatState {
  status: ChatStatus;
  turns: ChatTurn[];
  options: ChatOption[];
  commands: ChatCommand[];
  queued: string[];
  error: string | null;
  /** Live agent status, separate from conversation history and turn lifecycle. */
  notices: SessionNotice[];
  /** Context window use, when the agent reports it. */
  usage: { used: number; size: number } | null;
  draftKey?: string;
  /** Ephemeral sign-in progress; never persisted with drafts or conversation history. */
  startup?: { message: string; authUrl?: string };
}

export function lastOf<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

export function emptyChat(): ChatState {
  return { status: "starting", turns: [], options: [], commands: [], queued: [], error: null, notices: [], usage: null };
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

export function endTurn(state: ChatState, stopReason: string, error?: string | null): ChatState {
  const turn = lastOf(state.turns);
  if (!turn || turn.endedAt !== null) return state;
  return replaceLastTurn(state, { ...turn, endedAt: Date.now(), stopReason, ...(error ? { error } : {}) });
}

function replaceLastTurn(state: ChatState, turn: ChatTurn): ChatState {
  return { ...state, turns: [...state.turns.slice(0, -1), turn] };
}

/** Late updates amend their completed turn; only explicit prompts open another turn. */
function updateItems(state: ChatState, fn: (items: ChatItem[]) => ChatItem[], existingItemId?: string): ChatState {
  const base = state.turns.length ? state : startTurn(state, null);
  let index = base.turns.length - 1;
  if (existingItemId) {
    for (let i = index; i >= 0; i--) {
      if (base.turns[i].items.some(item => item.id === existingItemId)) { index = i; break; }
    }
  }
  return { ...base, turns: base.turns.map((turn, i) => i === index ? { ...turn, items: fn(turn.items) } : turn) };
}

let itemCounter = 0;
const nextItemId = () => `item-${++itemCounter}`;

export function addNotice(state: ChatState, text: string): ChatState {
  return updateItems(state, (items) => [...items, { kind: "notice", id: nextItemId(), text }]);
}

/** Remove only the adapter-identified prelude if it arrived before session/new resolved. */
export function removeStartupMessage(state: ChatState, text: string): ChatState {
  const first = state.turns[0];
  if (!first || first.prompt !== null) return state;
  const items = first.items.filter((item) => item.kind !== "message" || item.text !== text);
  if (items.length === first.items.length) return state;
  return { ...state, turns: items.length ? [{ ...first, items }, ...state.turns.slice(1)] : state.turns.slice(1) };
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

export function pendingRequest(state: ChatState) {
  return lastOf(state.turns)?.items.find(item =>
    (item.kind === "permission" && item.chosen === null) || (item.kind === "cursor_request" && item.outcome === null),
  ) as Extract<ChatItem, { kind: "permission" | "cursor_request" }> | undefined;
}

export function addCursorRequest(state: ChatState, id: string, request: CursorRequest): ChatState {
  return updateItems(state, items => [...items, { kind: "cursor_request", id, request, outcome: null }]);
}

export function resolveCursorRequest(state: ChatState, id: string, outcome: CursorOutcome): ChatState {
  return { ...state, turns: state.turns.map(turn => ({ ...turn, items: turn.items.map(item =>
    item.kind === "cursor_request" && item.id === id ? { ...item, outcome } : item,
  ) })) };
}

// ── Session updates ──────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
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
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  _meta?: { claudeCode?: { toolName?: string } };
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
  let output = "";
  for (const entry of content ?? []) {
    if (entry.type !== "content" || entry.content?.type !== "text") continue;
    const text = clipText(entry.content.text ?? "", MAX_TOOL_TEXT, true);
    output = clipText(output ? `${output}\n${text}` : text, MAX_TOOL_TEXT, true);
  }
  return output;
}

function toolDiffs(content: ToolCallContent[] | undefined): ToolDiff[] {
  return (content ?? [])
    .filter((entry) => entry.type === "diff" && entry.path)
    .slice(0, MAX_TOOL_DIFFS)
    .map((entry) => {
      const truncated = (entry.oldText?.length ?? 0) > MAX_DIFF_TEXT || (entry.newText?.length ?? 0) > MAX_DIFF_TEXT ||
        (entry.oldText?.split("\n").length ?? 0) + (entry.newText?.split("\n").length ?? 0) > 2000;
      return {
        path: clipText(entry.path!, 1000),
        oldText: truncated ? null : entry.oldText ?? null,
        newText: truncated ? "" : entry.newText ?? "",
        ...(truncated ? { truncated: true } : {}),
      };
    });
}

const TOOL_KINDS: Record<string, string> = {
  bash: "execute", shell: "execute", exec_command: "execute", run_command: "execute",
  read: "read", readfile: "read", read_file: "read", edit: "edit", write: "edit", multiedit: "edit", apply_patch: "edit",
  grep: "search", glob: "search", websearch: "search", web_search: "search", webfetch: "fetch", web_fetch: "fetch",
};

function toolKind(update: SessionUpdate, previous?: string): string {
  const name = update._meta?.claudeCode?.toolName?.toLowerCase() ?? "";
  return update.kind && update.kind !== "other" ? update.kind : TOOL_KINDS[name] ?? previous ?? update.kind ?? "other";
}

/** Some agents title a call with just its kind ("read"); prefer the target. */
function toolTitle(update: SessionUpdate, previous: string | undefined, kind: string): string | undefined {
  const input = update.rawInput ?? {};
  const text = (value: unknown) => typeof value === "string" && value.trim() ? clipText(value.trim(), 1000) : undefined;
  const command = input.command ?? input.cmd;
  const path = text(input.file_path ?? input.filePath ?? input.path ?? input.notebook_path ?? update.locations?.[0]?.path);
  if (kind === "execute") {
    const target = Array.isArray(command) ? command.slice(0, 64).map(text).filter(Boolean).join(" ") : text(command);
    if (target) return clipText(target, 1000);
  }
  if (kind === "search") {
    const query = text(input.pattern ?? input.query);
    if (query) return clipText(path ? `${query} in ${path}` : query, 1000);
  }
  if (kind === "fetch" && text(input.url ?? input.query)) return text(input.url ?? input.query);
  const title = text(update.title);
  const generic = !title || title.toLowerCase() === kind || TOOL_KINDS[title.toLowerCase()] === kind ||
    title.toLowerCase() === update._meta?.claudeCode?.toolName?.toLowerCase();
  return !generic ? title : (path ? path.split("/").pop() : undefined) ?? previous ?? text(update._meta?.claudeCode?.toolName) ?? title;
}

function upsertTool(state: ChatState, update: SessionUpdate): ChatState {
  const id = `tool-${update.toolCallId}`;
  const content = update.content as ToolCallContent[] | undefined;
  return updateItems(state, (items) => {
    const index = items.findIndex((item) => item.id === id);
    const existing = index === -1 ? null : items[index];
    const previous = existing?.kind === "tool" ? existing : null;
    const output = toolOutput(content) || rawToolOutput(update.rawOutput);
    const diffs = toolDiffs(content);
    const kind = toolKind(update, previous?.toolKind);
    const next: ChatItem = {
      kind: "tool",
      id,
      title: toolTitle(update, previous?.title, kind) ?? "Tool call",
      toolKind: kind,
      status: update.status ?? previous?.status ?? "pending",
      output: output || (previous?.output ?? ""),
      diffs: diffs.length ? diffs : previous?.diffs ?? [],
      omittedDiffs: diffs.length ? Math.max(0, (content?.filter((entry) => entry.type === "diff" && entry.path).length ?? 0) - MAX_TOOL_DIFFS) : previous?.omittedDiffs,
    };
    if (index === -1) return [...items, next];
    const copy = [...items];
    copy[index] = next;
    return copy;
  }, update.sessionUpdate === "tool_call_update" ? id : undefined);
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
    case "notice": {
      const title = typeof update.title === "string" ? update.title.trim() : "";
      if (!title || typeof update.severity !== "string") return state;
      const severity = update.severity;
      const description = typeof update.description === "string" ? update.description.trim() || null : null;
      const notices = state.notices ?? [];
      // Coalesce repeated live warnings; dismissal stays local to this chat.
      if (notices.some((notice) => notice.title === title && notice.description === description && notice.severity === severity)) return state;
      return { ...state, notices: [...notices.slice(-4), { id: nextItemId(), title, description, severity }] };
    }
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
      if (update.content?.type !== "text") {
        const media = update.content && agentMedia(update.content);
        return media ? updateItems(state, (items) => [...items, { kind: "media", id: nextItemId(), content: media }]) : state;
      }
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
  description?: string;
  type: string;
  category?: string;
  currentValue: string;
  options?: { value: string; name: string; description?: string }[];
}

export interface AcpSessionInfo {
  _meta?: { piAcp?: { startupInfo?: string | null } };
  configOptions?: AcpConfigOption[];
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null;
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
      description: option.description,
      category: option.category,
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
  const modes = session.modes;
  // Pi exposes the same thinking selector through both modern config and legacy modes.
  const hasModeConfig = options.some((option) => (option.category === "mode" || option.category === "thought_level") &&
    option.value === modes?.currentModeId && option.choices.length === modes.availableModes.length &&
    modes.availableModes.every((mode) => option.choices.some((choice) => choice.value === mode.id)));
  if (modes?.availableModes.length && !has("mode") && !hasModeConfig) {
    options.push({
      id: "mode",
      name: "Mode",
      value: modes.currentModeId,
      choices: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })),
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
