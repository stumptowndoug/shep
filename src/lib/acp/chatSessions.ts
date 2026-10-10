import { AcpConnection, AcpError } from "./connection";
import {
  addNotice,
  addPermission,
  applySessionUpdate,
  endTurn,
  optionsFromSession,
  resolvePermission,
  setOptionValue,
  startTurn,
  type AcpSessionInfo,
  type PermissionOption,
} from "./chatModel";
import { useChatStore } from "../../stores/useChatStore";
import { useTerminalStore, nextTabId } from "../../stores/useTerminalStore";
import { recordSessionHistoryActivity, upsertSessionHistory } from "../tauri";
import { notifyAgent } from "../notifications";
import type { AgentSemanticState, CodingAssistant, SessionMode } from "../types";

/** Mode ids adapters use for "run without asking" (Claude, Codex, others). */
const FULL_ACCESS_MODES = ["bypassPermissions", "full-access", "agent-full-access", "yolo", "full"];
const TITLE_MAX_CHARS = 60;

interface LiveChat {
  connection: AcpConnection;
  assistant: CodingAssistant;
  repoPath: string;
  mode: SessionMode;
  sessionId: string | null;
  startedAt: number;
  model: string | null;
  titled: boolean;
  history: Promise<void>;
  permissions: Map<string, (optionId: string | null) => void>;
}

const live = new Map<number, LiveChat>();

export interface StartChatOptions {
  assistant: CodingAssistant;
  repoPath: string;
  mode: SessionMode;
  model?: string;
  /** Resume an earlier provider session through `session/load`. */
  resume?: { sessionId: string; title: string | null; startedAt: number };
}

// ── Public API ───────────────────────────────────────────────────────

/** Start an ACP agent in a new chat tab. Resolves with the tab's session id. */
export async function startChat(options: StartChatOptions): Promise<number> {
  const { assistant, repoPath, mode, resume } = options;
  const adapter = assistant.acp;
  if (!adapter) throw new Error(`${assistant.name} has no chat adapter`);

  let chatId = -1;
  const connection = await AcpConnection.spawn(adapter.command, adapter.args, repoPath, {
    onRequest: (method, params) => handleRequest(chatId, method, params),
    onNotification: (method, params) => {
      if (method === "session/update") {
        const update = (params as { update?: Parameters<typeof applySessionUpdate>[1] }).update;
        if (update) useChatStore.getState().update(chatId, (chat) => applySessionUpdate(chat, update));
      }
    },
    onExit: (code, stderr) => handleExit(chatId, code, stderr),
  });
  chatId = connection.id;

  live.set(chatId, {
    connection,
    assistant,
    repoPath,
    mode,
    sessionId: resume?.sessionId ?? null,
    startedAt: resume?.startedAt ?? Date.now(),
    model: options.model ?? null,
    titled: Boolean(resume?.title),
    history: Promise.resolve(),
    permissions: new Map(),
  });
  useChatStore.getState().init(chatId);
  const terminals = useTerminalStore.getState();
  terminals.initActivity(chatId);
  terminals.addTab({
    id: nextTabId(),
    kind: "assistant",
    label: resume?.title ?? assistant.name,
    ptyId: chatId,
    repoPath,
    commandName: null,
    assistantId: assistant.id,
    providerSessionId: resume?.sessionId ?? null,
    sessionMode: mode,
    labelSource: resume?.title ? "session" : "default",
    agentInterface: "chat",
  });

  void openSession(chatId, options).catch((error: unknown) => {
    failChat(chatId, describeStartError(assistant, error));
  });
  return chatId;
}

export function sendPrompt(chatId: number, text: string) {
  const prompt = text.trim();
  const chat = useChatStore.getState().chats[chatId];
  if (!prompt || !chat || chat.status === "exited") return;
  if (chat.status !== "ready") {
    useChatStore.getState().update(chatId, (state) => ({ ...state, queued: [...state.queued, prompt] }));
    return;
  }
  void runTurn(chatId, prompt);
}

export function cancelTurn(chatId: number) {
  const session = live.get(chatId);
  if (!session?.sessionId) return;
  for (const resolve of session.permissions.values()) resolve(null);
  useChatStore.getState().update(chatId, (state) => ({ ...state, queued: [] }));
  session.connection.notify("session/cancel", { sessionId: session.sessionId });
}

export function answerPermission(chatId: number, itemId: string, optionId: string) {
  live.get(chatId)?.permissions.get(itemId)?.(optionId);
}

export async function setChatOption(chatId: number, optionId: string, value: string) {
  const session = live.get(chatId);
  const option = useChatStore.getState().chats[chatId]?.options.find((entry) => entry.id === optionId);
  if (!session?.sessionId || !option) return;
  const { sessionId, connection } = session;
  const previous = option.value;
  useChatStore.getState().update(chatId, (state) => setOptionValue(state, optionId, value));
  try {
    if (option.source === "mode") {
      await connection.request("session/set_mode", { sessionId, modeId: value });
    } else if (option.source === "model") {
      await connection.request("session/set_model", { sessionId, modelId: value });
    } else {
      await connection.request("session/set_config_option", { sessionId, configId: optionId, value });
    }
  } catch (error) {
    useChatStore.getState().update(chatId, (state) =>
      addNotice(setOptionValue(state, optionId, previous), `Couldn’t change ${option.name}: ${errorText(error)}`),
    );
  }
}

/** Stop the agent process and drop the conversation state. */
export async function closeChat(chatId: number) {
  const session = live.get(chatId);
  live.delete(chatId);
  useChatStore.getState().remove(chatId);
  useTerminalStore.getState().removeActivity(chatId);
  if (session) {
    for (const resolve of session.permissions.values()) resolve(null);
    await session.connection.kill().catch(() => {});
    if (session.sessionId) {
      await recordHistoryActivity(session, true);
    }
  }
}

// ── Session lifecycle ────────────────────────────────────────────────

interface InitializeResult {
  agentCapabilities?: { loadSession?: boolean };
  authMethods?: { id: string; name: string; description?: string }[];
}

async function openSession(chatId: number, options: StartChatOptions) {
  const session = live.get(chatId);
  if (!session) return;
  const { connection, repoPath } = session;

  const init = await connection.request<InitializeResult>("initialize", {
    protocolVersion: 1,
    // Agents read, write and run commands themselves, exactly as their CLI does.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "shep", version: "1" },
  });

  let info: AcpSessionInfo & { sessionId?: string };
  if (options.resume && init.agentCapabilities?.loadSession) {
    info = await connection.request("session/load", {
      sessionId: options.resume.sessionId,
      cwd: repoPath,
      mcpServers: [],
    });
    // History replays as user/agent chunks; close the last replayed turn.
    useChatStore.getState().update(chatId, (chat) => endTurn(chat, "end_turn"));
  } else {
    if (options.resume) {
      useChatStore.getState().update(chatId, (chat) =>
        addNotice(chat, `${session.assistant.name} can’t reload earlier conversations in chat, so this is a new session.`),
      );
    }
    info = await connection.request("session/new", { cwd: repoPath, mcpServers: [] });
    session.sessionId = info.sessionId ?? null;
  }
  if (!live.has(chatId)) return;

  useChatStore.getState().update(chatId, (chat) => ({ ...chat, options: optionsFromSession(info) }));
  if (session.mode === "yolo") await enableFullAccess(chatId);
  if (options.model) await setChatOption(chatId, "model", options.model);
  if (!live.has(chatId)) return;

  if (session.sessionId) {
    useTerminalStore.getState().setTabSessionInfo(chatId, session.sessionId, options.resume?.title ?? null);
    void persistHistory(session, options.resume?.title ?? null);
  }
  setReady(chatId);
}

async function enableFullAccess(chatId: number) {
  const mode = useChatStore.getState().chats[chatId]?.options.find((option) => option.id === "mode");
  const full = mode?.choices.find((choice) => FULL_ACCESS_MODES.includes(choice.value));
  if (mode && full && mode.value !== full.value) await setChatOption(chatId, mode.id, full.value);
}

async function runTurn(chatId: number, prompt: string) {
  const session = live.get(chatId);
  if (!session?.sessionId) return;
  const store = useChatStore.getState();
  store.update(chatId, (chat) => ({ ...startTurn(chat, prompt), status: "working" }));
  setAgentState(chatId, "working", "Agent is responding");
  if (!session.titled) {
    session.titled = true;
    const title = summarizeTitle(prompt);
    useTerminalStore.getState().setTabSessionInfo(chatId, session.sessionId, title);
    void persistHistory(session, title);
  }

  let stopReason = "end_turn";
  try {
    const result = await session.connection.request<{ stopReason?: string }>("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    stopReason = result?.stopReason ?? "end_turn";
  } catch (error) {
    if (!live.has(chatId)) return;
    stopReason = "error";
    store.update(chatId, (chat) => addNotice(chat, errorText(error)));
  }
  if (!live.has(chatId)) return;

  store.update(chatId, (chat) => endTurn(chat, stopReason));
  void recordHistoryActivity(session, false);
  if (!isChatVisible(chatId) && stopReason !== "cancelled") {
    void notifyAgent(chatId, `${session.assistant.name} finished`);
  }
  setReady(chatId);
}

/** Mark the chat idle and send the next queued prompt, if any. */
function setReady(chatId: number) {
  const chat = useChatStore.getState().chats[chatId];
  if (!chat || chat.status === "exited") return;
  const [next, ...rest] = chat.queued;
  useChatStore.getState().update(chatId, (state) => ({ ...state, status: "ready", queued: rest }));
  setAgentState(chatId, "idle", "Waiting for a prompt");
  if (next) void runTurn(chatId, next);
}

async function handleRequest(chatId: number, method: string, params: unknown) {
  if (method !== "session/request_permission") {
    throw new AcpError(`${method} is not supported by Shep`, -32601);
  }
  const session = live.get(chatId);
  const { toolCall, options } = params as {
    toolCall?: { title?: string };
    options: PermissionOption[];
  };
  if (!session) return { outcome: { outcome: "cancelled" } };

  if (session.mode === "yolo") {
    // allow_once, not allow_always: "always" makes some adapters write
    // permanent rules into the project's settings files.
    const allow = options.find((option) => option.kind === "allow_once")
      ?? options.find((option) => option.kind === "allow_always");
    if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  const itemId = `permission-${crypto.randomUUID()}`;
  const title = toolCall?.title ?? "Run a tool";
  useChatStore.getState().update(chatId, (chat) => addPermission(chat, itemId, title, options));
  setAgentState(chatId, "blocked", "Waiting for permission");
  if (!isChatVisible(chatId)) void notifyAgent(chatId, `${session.assistant.name} needs permission: ${title}`);

  const optionId = await new Promise<string | null>((resolve) => session.permissions.set(itemId, resolve));
  session.permissions.delete(itemId);
  useChatStore.getState().update(chatId, (chat) => resolvePermission(chat, itemId, optionId));
  if (live.has(chatId)) setAgentState(chatId, "working", "Agent is responding");
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function handleExit(chatId: number, code: number, stderr: string) {
  const session = live.get(chatId);
  if (!session) return;
  live.delete(chatId);
  for (const resolve of session.permissions.values()) resolve(null);
  const detail = stderr.trim().split("\n").slice(-3).join("\n");
  failChat(chatId, code === 0 ? null : `${session.assistant.name} exited (code ${code}).${detail ? `\n${detail}` : ""}`);
  useTerminalStore.getState().setTabExited(chatId, code);
}

function failChat(chatId: number, error: string | null) {
  useChatStore.getState().update(chatId, (chat) => ({
    ...endTurn(chat, "error"),
    status: "exited",
    queued: [],
    error: error ?? chat.error,
  }));
  const session = live.get(chatId);
  if (session) {
    live.delete(chatId);
    void session.connection.kill().catch(() => {});
    useTerminalStore.getState().setTabExited(chatId, 1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function setAgentState(chatId: number, state: AgentSemanticState, reason: string) {
  const terminals = useTerminalStore.getState();
  terminals.setTabActive(chatId, state === "working");
  terminals.setTabAgentState(chatId, {
    state,
    updatedAt: Date.now(),
    source: "provider",
    reason,
    ruleId: null,
  });
}

function isChatVisible(chatId: number): boolean {
  const { activeProjectPath, projectState } = useTerminalStore.getState();
  if (!activeProjectPath) return false;
  const project = projectState[activeProjectPath];
  const tab = project?.tabs.find((entry) => entry.id === project.activeTabId);
  return Boolean(tab && "ptyId" in tab && tab.ptyId === chatId && document.hasFocus());
}

function persistHistory(session: LiveChat, title: string | null) {
  if (!session.sessionId) return Promise.resolve();
  const record = {
    provider: session.assistant.id,
    sessionId: session.sessionId,
    projectPath: session.repoPath,
    title,
    model: session.model,
    startedAt: session.startedAt,
    lastActivityAt: Date.now(),
  };
  session.history = session.history.then(() => upsertSessionHistory(record)).catch((error) => {
    if (import.meta.env.DEV) console.warn("Failed to record chat history:", error);
  });
  return session.history;
}

function recordHistoryActivity(session: LiveChat, ended: boolean) {
  const sessionId = session.sessionId;
  if (!sessionId) return Promise.resolve();
  const timestamp = Date.now();
  // Native database work is asynchronous; preserve start → activity → end
  // ordering so a delayed title save cannot reopen an already closed session.
  session.history = session.history.then(() =>
    recordSessionHistoryActivity(session.assistant.id, sessionId, timestamp, ended),
  ).catch((error) => {
    if (import.meta.env.DEV) console.warn("Failed to update chat history:", error);
  });
  return session.history;
}

function summarizeTitle(prompt: string): string {
  const line = prompt.split("\n").find((entry) => entry.trim())?.trim() ?? prompt;
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStartError(assistant: CodingAssistant, error: unknown): string {
  if (error instanceof AcpError && (error.code === -32000 || /auth/i.test(error.message))) {
    return `${assistant.name} isn’t signed in. Start it once in a terminal tab and log in, then try chat again.`;
  }
  return `Couldn’t start ${assistant.name}: ${errorText(error)}`;
}
