import { AcpConnection, AcpError } from "./connection";
import {
  addNotice,
  addCursorRequest,
  addPermission,
  applySessionUpdate,
  endTurn,
  optionsFromSession,
  pendingRequest,
  removeStartupMessage,
  resolvePermission,
  resolveCursorRequest,
  setOptionValue,
  startTurn,
  type AcpSessionInfo,
  type PermissionOption,
} from "./chatModel";
import { useChatStore } from "../../stores/useChatStore";
import { useChatModelStore } from "../../stores/useChatModelStore";
import { chatDraftKey, useChatDraftStore } from "../../stores/useChatDraftStore";
import { useTerminalStore, nextTabId } from "../../stores/useTerminalStore";
import { killAcpAgent, recordSessionHistoryActivity, upsertSessionHistory } from "../tauri";
import { notifyAgent } from "../notifications";
import type { AgentSemanticState, CodingAssistant, SessionMode } from "../types";
import { isAccessOption, isFullAccessMode, isModelOption } from "./chatOptions";
import { applyCursorNotification, parseCursorRequest, validCursorOutcome, type CursorOutcome } from "./cursorProtocol";
import { chatAdapterCommand } from "./adapters";
import { antigravitySignInUrl } from "./antigravityProtocol";

const TITLE_MAX_CHARS = 60;
const STARTUP_TIMEOUT_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const CANCEL_TIMEOUT_MS = 5_000;

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
  interactions?: Map<string, (outcome: CursorOutcome) => void>;
  cancelling?: boolean;
  cancelTimer?: number;
  startupMessage: string | null;
}

// React refresh keeps chat tabs mounted; retain their live connections too.
const live: Map<number, LiveChat> = import.meta.hot?.data.liveChats ?? new Map();
if (import.meta.hot) import.meta.hot.dispose((data) => { data.liveChats = live; });

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

  const runtime = await chatAdapterCommand(adapter);
  let chatId = -1;
  const connection = await AcpConnection.spawn(runtime.command, runtime.args, repoPath, {
    onRequest: (method, params) => handleRequest(chatId, method, params),
    onNotification: (method, params) => {
      if (method === "session/update") {
        const update = (params as { update?: Parameters<typeof applySessionUpdate>[1] }).update;
        if (update) {
          const session = live.get(chatId);
          if (session?.startupMessage && update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" && update.content.text === session.startupMessage) {
            session.startupMessage = null;
            return;
          }
          const previous = useChatStore.getState().chats[chatId]?.options.find(isAccessOption)?.value;
          useChatStore.getState().update(chatId, (chat) => applySessionUpdate(chat, update));
          const access = useChatStore.getState().chats[chatId]?.options.find(isAccessOption);
          if (access && previous !== access.value) syncAccessPolicy(chatId, access.value);
        }
      } else if (assistant.id === "cursor" && method.startsWith("cursor/")) {
        if (!live.get(chatId)?.cancelling) useChatStore.getState().update(chatId, chat => applyCursorNotification(chat, method, params));
      }
    },
    onExit: (code, stderr) => handleExit(chatId, code, stderr),
    onStderr: (line) => {
      if (assistant.id !== "antigravity" || !live.has(chatId)) return;
      const url = antigravitySignInUrl(line);
      if (!url) return;
      const chat = useChatStore.getState().chats[chatId];
      if (chat?.status !== "starting" || !chat.startup) return;
      useChatStore.getState().update(chatId, chat => ({ ...chat, startup: { message: "Sign in with Google to connect Antigravity.", authUrl: url } }));
      setAgentState(chatId, "blocked", "Waiting for Google sign-in");
    },
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
    interactions: new Map(),
    startupMessage: null,
  });
  useChatStore.getState().init(chatId);
  const draftKey = chatDraftKey(assistant.id, repoPath, resume?.sessionId ?? `pending:${crypto.randomUUID()}`);
  useChatDraftStore.getState().load(draftKey);
  useChatStore.getState().update(chatId, (chat) => ({ ...chat, draftKey }));
  const terminals = useTerminalStore.getState();
  terminals.initActivity(chatId);
  const added = terminals.addTab({
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
  if (!added) {
    await closeChat(chatId);
    throw new Error("The project was closed while the agent was starting.");
  }
  setAgentState(chatId, "working", "Starting agent");

  let startupTimer: number;
  const resetStartupTimer = (signingIn = false) => {
    window.clearTimeout(startupTimer);
    startupTimer = window.setTimeout(() => {
      if (!live.has(chatId)) return;
      failChat(chatId, signingIn
        ? "Google sign-in timed out. Close this tab and start a new Antigravity chat to try again."
        : `${assistant.name} didn’t finish starting within 60 seconds. Check your connection and agent sign-in, then close this tab and start a new chat.`);
    }, signingIn ? SIGN_IN_TIMEOUT_MS : STARTUP_TIMEOUT_MS);
  };
  resetStartupTimer();
  void openSession(chatId, options, resetStartupTimer)
    .catch((error: unknown) => {
      // A timeout or tab close already supplied the final state. The pending
      // request rejects when we kill the adapter; keep the original error.
      if (live.has(chatId)) failChat(chatId, describeStartError(assistant, error));
    })
    .finally(() => window.clearTimeout(startupTimer));
  return chatId;
}

export function cancelChatStartup(chatId: number) {
  if (useChatStore.getState().chats[chatId]?.status === "starting") {
    failChat(chatId, "Sign-in cancelled. Start a new chat when you’re ready to connect.", 0);
  }
}

export function sendPrompt(chatId: number, text: string): boolean {
  const prompt = text.trim();
  const chat = useChatStore.getState().chats[chatId];
  if (!prompt || !chat || chat.status === "exited" || !live.has(chatId)) return false;
  if (chat.status !== "ready") {
    useChatStore.getState().update(chatId, (state) => ({ ...state, queued: [...state.queued, prompt] }));
    return true;
  }
  void runTurn(chatId, prompt);
  return true;
}

export function cancelTurn(chatId: number) {
  const session = live.get(chatId);
  if (!session?.sessionId) return;
  cancelPendingRequests(session);
  useChatStore.getState().update(chatId, (state) => ({ ...state, queued: [] }));
  setAgentState(chatId, "idle", "Stopped");
  session.connection.notify("session/cancel", { sessionId: session.sessionId });
  if (session.cancelTimer === undefined && useChatStore.getState().chats[chatId]?.status === "working") {
    session.cancelTimer = window.setTimeout(() => {
      if (live.get(chatId) !== session) return;
      failChat(chatId, "The agent did not respond to Stop and was closed. Resume this conversation from History or start a new chat.", 0);
    }, CANCEL_TIMEOUT_MS);
  }
}

export function answerPermission(chatId: number, itemId: string, optionId: string) {
  const item = useChatStore.getState().chats[chatId]?.turns.flatMap(turn => turn.items).find(item => item.id === itemId);
  if (item?.kind === "permission" && item.options.some(option => option.optionId === optionId)) {
    live.get(chatId)?.permissions.get(itemId)?.(optionId);
  }
}

export function answerCursorRequest(chatId: number, itemId: string, outcome: CursorOutcome) {
  const session = live.get(chatId);
  const item = useChatStore.getState().chats[chatId]?.turns.flatMap(turn => turn.items).find(item => item.id === itemId);
  if (item?.kind !== "cursor_request" || item.outcome !== null || !validCursorOutcome(item.request, outcome)) return false;
  const resolve = session?.interactions?.get(itemId);
  if (!resolve) return false;
  session!.interactions!.delete(itemId);
  resolve(outcome);
  return true;
}

function cancelPendingRequests(session: LiveChat) {
  session.cancelling = true;
  for (const resolve of session.permissions.values()) resolve(null);
  for (const resolve of session.interactions?.values() ?? []) resolve({ outcome: "cancelled" });
}

export async function setChatOption(chatId: number, optionId: string, value: string) {
  return changeChatOption(chatId, optionId, value, true);
}

async function changeChatOption(chatId: number, optionId: string, value: string, rememberModel: boolean) {
  const session = live.get(chatId);
  const option = useChatStore.getState().chats[chatId]?.options.find((entry) => entry.id === optionId);
  if (!session?.sessionId || !option || !option.choices.some((choice) => choice.value === value)) return;
  const { sessionId, connection } = session;
  const previous = option.value;
  const previousMode = session.mode;
  const access = isAccessOption(option);
  // Stop automatic approval immediately when asking for a more restrictive mode.
  if (access && !isFullAccessMode(value)) session.mode = "standard";
  useChatStore.getState().update(chatId, (state) => setOptionValue(state, optionId, value));
  try {
    let result: AcpSessionInfo | undefined;
    if (option.source === "mode") {
      await connection.request("session/set_mode", { sessionId, modeId: value });
    } else if (option.source === "model") {
      await connection.request("session/set_model", { sessionId, modelId: value });
    } else {
      result = await connection.request<AcpSessionInfo>("session/set_config_option", { sessionId, configId: optionId, value });
    }
    if (live.get(chatId) !== session) return;
    // Providers may clamp a choice (e.g. Fast mode unavailable) or change related settings.
    if (result?.configOptions) useChatStore.getState().update(chatId, (state) => ({ ...state, options: optionsFromSession(result!) }));
    if (access) syncAccessPolicy(chatId, useChatStore.getState().chats[chatId]?.options.find((entry) => entry.id === optionId)?.value ?? value);
    if (isModelOption(option)) {
      const current = useChatStore.getState().chats[chatId]?.options.find(isModelOption);
      session.model = current?.value ?? null;
      const accepted = current?.choices.find((choice) => choice.value === current.value);
      if (rememberModel && accepted?.value === value) {
        useChatModelStore.getState().remember(session.assistant.id, { id: accepted.value, name: accepted.name });
      }
    }
  } catch (error) {
    if (live.get(chatId) !== session) return;
    if (access) {
      session.mode = previousMode;
      useTerminalStore.getState().setTabSessionMode(chatId, previousMode);
    }
    useChatStore.getState().update(chatId, (state) =>
      addNotice(setOptionValue(state, optionId, previous), `Couldn’t change ${option.name}: ${errorText(error)}`),
    );
  }
}

function syncAccessPolicy(chatId: number, value: string) {
  const session = live.get(chatId);
  if (!session) return;
  const mode = isFullAccessMode(value) ? "yolo" : "standard";
  session.mode = mode;
  useTerminalStore.getState().setTabSessionMode(chatId, mode);
}

/** Stop the agent process and drop the conversation state. */
export async function closeChat(chatId: number) {
  const session = live.get(chatId);
  live.delete(chatId);
  useChatStore.getState().remove(chatId);
  useTerminalStore.getState().removeActivity(chatId);
  if (session) {
    window.clearTimeout(session.cancelTimer);
    cancelPendingRequests(session);
    await session.connection.kill().catch(() => {});
    if (session.sessionId) {
      await recordHistoryActivity(session, true);
    }
  } else {
    // The native registry still owns this id if frontend state was lost during
    // a reload. Closing its tab must stop that process even without a connection.
    await killAcpAgent(chatId).catch(() => {});
  }
}

// ── Session lifecycle ────────────────────────────────────────────────

interface InitializeResult {
  agentCapabilities?: { loadSession?: boolean };
  authMethods?: { id: string; name: string; description?: string }[];
}

async function openSession(chatId: number, options: StartChatOptions, resetStartupTimer: (signingIn?: boolean) => void) {
  const session = live.get(chatId);
  if (!session) return;
  const { connection, repoPath } = session;

  const init = await connection.request<InitializeResult>("initialize", {
    protocolVersion: 1,
    // Agents read, write and run commands themselves, exactly as their CLI does.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } },
    clientInfo: { name: "shep", version: "1" },
  });

  const authMethodId = session.assistant.acp?.authMethodId;
  if (authMethodId) {
    if (!init.authMethods?.some(method => method.id === authMethodId)) {
      throw new Error(`Update ${session.assistant.name} CLI to a version that supports chat authentication.`);
    }
    const browserSignIn = session.assistant.id === "antigravity";
    if (browserSignIn) {
      useChatStore.getState().update(chatId, chat => ({ ...chat, startup: { message: "Connecting your Google account…" } }));
      resetStartupTimer(true);
    }
    await connection.request("authenticate", { methodId: authMethodId });
    if (!live.has(chatId)) return;
    if (browserSignIn) {
      useChatStore.getState().update(chatId, chat => ({ ...chat, startup: undefined }));
      setAgentState(chatId, "working", "Starting agent");
      resetStartupTimer();
    }
  }

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

  if (session.sessionId) {
    const draftKey = chatDraftKey(session.assistant.id, repoPath, session.sessionId);
    const previous = useChatStore.getState().chats[chatId]?.draftKey;
    if (previous) useChatDraftStore.getState().moveDraft(previous, draftKey);
    else useChatDraftStore.getState().load(draftKey);
    useChatStore.getState().update(chatId, (chat) => ({ ...chat, draftKey }));
  }

  const startupMessage = options.assistant.id === "pi" && !options.resume ? info._meta?.piAcp?.startupInfo : null;
  if (typeof startupMessage === "string" && startupMessage) {
    session.startupMessage = startupMessage;
    useChatStore.getState().update(chatId, (chat) => {
      const updated = removeStartupMessage(chat, startupMessage);
      if (updated !== chat) session.startupMessage = null;
      return updated;
    });
  }

  const sessionOptions = optionsFromSession(info);
  useChatStore.getState().update(chatId, (chat) => ({ ...chat, options: sessionOptions }));
  const access = sessionOptions.find(isAccessOption);
  if (access) syncAccessPolicy(chatId, access.value);
  if (options.mode === "yolo") await enableFullAccess(chatId);
  // Resumed conversations retain the model returned by session/load. Replaying
  // a preference must not replace a newer choice made in another open chat.
  if (!options.resume) {
    const model = useChatStore.getState().chats[chatId]?.options.find(isModelOption);
    const preferred = options.model ?? useChatModelStore.getState().models[options.assistant.id]?.id;
    if (model && preferred && preferred !== model.value && model.choices.some((choice) => choice.value === preferred)) {
      await changeChatOption(chatId, model.id, preferred, false);
    }
  }
  if (!live.has(chatId)) return;
  session.model = useChatStore.getState().chats[chatId]?.options.find(isModelOption)?.value ?? null;

  if (session.sessionId) {
    useTerminalStore.getState().setTabSessionInfo(chatId, session.sessionId, options.resume?.title ?? null);
    void persistHistory(session, options.resume?.title ?? null);
  }
  setReady(chatId);
}

async function enableFullAccess(chatId: number) {
  const mode = useChatStore.getState().chats[chatId]?.options.find(isAccessOption);
  const full = mode?.choices.find((choice) => isFullAccessMode(choice.value));
  if (mode && full && mode.value !== full.value) await setChatOption(chatId, mode.id, full.value);
}

async function runTurn(chatId: number, prompt: string) {
  const session = live.get(chatId);
  if (!session?.sessionId) return;
  session.cancelling = false;
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
  let turnError: string | undefined;
  try {
    const result = await session.connection.request<{ stopReason?: string }>("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    stopReason = result?.stopReason ?? "end_turn";
  } catch (error) {
    if (!live.has(chatId)) return;
    stopReason = session.cancelling ? "cancelled" : "error";
    if (!session.cancelling) turnError = errorText(error);
  } finally {
    window.clearTimeout(session.cancelTimer);
    session.cancelTimer = undefined;
  }
  if (!live.has(chatId)) return;

  cancelPendingRequests(session);
  store.update(chatId, (chat) => endTurn(chat, stopReason, turnError));
  void recordHistoryActivity(session, false);
  if (!isChatVisible(chatId) && stopReason !== "cancelled") {
    void notifyAgent(chatId, stopReason === "error" ? `${session.assistant.name} needs you: ${turnError ?? "Request failed"}` : `${session.assistant.name} finished`, { attention: false });
  }
  setReady(chatId, stopReason === "error" ? turnError ?? "Request failed" : undefined);
}

/** Mark the chat idle and send the next queued prompt, if any. */
function setReady(chatId: number, error?: string) {
  const chat = useChatStore.getState().chats[chatId];
  if (!chat || chat.status === "exited") return;
  const [next, ...rest] = chat.queued;
  useChatStore.getState().update(chatId, (state) => ({ ...state, status: "ready", queued: rest }));
  setAgentState(chatId, error ? "blocked" : "idle", error ?? "Waiting for a prompt");
  if (next) void runTurn(chatId, next);
}

async function handleRequest(chatId: number, method: string, params: unknown) {
  const session = live.get(chatId);
  if (!session || session.cancelling) return { outcome: { outcome: "cancelled" } };
  // Cursor also sends its fire-and-forget extensions as JSON-RPC requests in
  // some CLI versions. Acknowledge them without asking the user or doing work.
  if (session.assistant.id === "cursor" && ["cursor/update_todos", "cursor/task", "cursor/generate_image"].includes(method)) {
    useChatStore.getState().update(chatId, chat => applyCursorNotification(chat, method, params));
    return {};
  }
  if (session.assistant.id === "cursor" && (method === "cursor/ask_question" || method === "cursor/create_plan")) {
    let request;
    try { request = parseCursorRequest(method, params); }
    catch (error) { throw new AcpError(`Invalid Cursor request: ${errorText(error)}`, -32602); }
    if (!request) throw new AcpError(`${method} is not supported by Shep`, -32601);
    const itemId = `cursor-${crypto.randomUUID()}`;
    useChatStore.getState().update(chatId, chat => addCursorRequest(chat, itemId, request));
    setAgentState(chatId, "blocked", request.kind === "plan" ? "Waiting for plan approval" : "Waiting for your answer");
    if (!isChatVisible(chatId)) void notifyAgent(chatId, request.kind === "plan" ? "Cursor needs plan approval" : "Cursor needs your input", { attention: false });
    // Questions and plan approval always need a human decision, including in Full access.
    session.interactions ??= new Map();
    const outcome = await new Promise<CursorOutcome>(resolve => session.interactions!.set(itemId, resolve));
    session.interactions.delete(itemId);
    useChatStore.getState().update(chatId, chat => resolveCursorRequest(chat, itemId, outcome));
    refreshWaitingState(chatId);
    return { outcome };
  }
  if (method !== "session/request_permission") {
    throw new AcpError(`${method} is not supported by Shep`, -32601);
  }
  const { toolCall, options } = params as {
    toolCall?: { title?: string };
    options: PermissionOption[];
  };

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
  if (!isChatVisible(chatId)) void notifyAgent(chatId, `${session.assistant.name} needs permission: ${title}`, { attention: false });

  const optionId = await new Promise<string | null>((resolve) => session.permissions.set(itemId, resolve));
  session.permissions.delete(itemId);
  useChatStore.getState().update(chatId, (chat) => resolvePermission(chat, itemId, optionId));
  refreshWaitingState(chatId);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function refreshWaitingState(chatId: number) {
  const chat = useChatStore.getState().chats[chatId];
  if (!live.has(chatId) || live.get(chatId)?.cancelling || chat?.status !== "working") return;
  if (pendingRequest(chat)) setAgentState(chatId, "blocked", "Waiting for your input");
  else setAgentState(chatId, "working", "Agent is responding");
}

function handleExit(chatId: number, code: number, stderr: string) {
  const session = live.get(chatId);
  if (!session) return;
  live.delete(chatId);
  cancelPendingRequests(session);
  const detail = stderr.trim().split("\n")
    .filter(line => !line.includes("Open the following link to authenticate the ACP server:"))
    .slice(-3).join("\n");
  failChat(chatId, code === 0 ? null : `${session.assistant.name} exited (code ${code}).${detail ? `\n${detail}` : ""}`);
  useTerminalStore.getState().setTabExited(chatId, code);
}

function failChat(chatId: number, error: string | null, exitCode = 1) {
  useChatStore.getState().update(chatId, (chat) => ({
    ...endTurn(chat, "error"),
    status: "exited",
    queued: [],
    startup: undefined,
    error: error ?? chat.error,
  }));
  const session = live.get(chatId);
  if (session) {
    window.clearTimeout(session.cancelTimer);
    cancelPendingRequests(session);
    live.delete(chatId);
    void session.connection.kill().catch(() => {});
    useTerminalStore.getState().setTabExited(chatId, exitCode);
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
    agentInterface: "chat" as const,
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
    if (assistant.id === "antigravity") return "Antigravity couldn’t complete Google sign-in. Close this tab and start a new chat to sign in again.";
    if (assistant.id === "cursor") return "Cursor isn’t signed in. Run `cursor-agent login` in a terminal, then open a new chat.";
    return `${assistant.name} isn’t signed in. Start it once in a terminal tab and log in, then try chat again.`;
  }
  return `Couldn’t start ${assistant.name}: ${errorText(error)}`;
}
