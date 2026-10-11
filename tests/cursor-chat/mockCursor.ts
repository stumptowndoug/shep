import type { Channel } from "@tauri-apps/api/core";
import type { AcpOutput } from "../../src/lib/tauri";

export const question = { toolCallId: "question-1", title: "Choose the scope", questions: [
  { id: "scope", prompt: "How much should change?", options: [{ id: "chat", label: "Just the chat interface" }, { id: "workspace", label: "The whole workspace" }] },
  { id: "checks", prompt: "Which checks should I include?", allowMultiple: true, options: [{ id: "unit", label: "Unit tests" }, { id: "visual", label: "Light and dark visual checks" }] },
] };
export const plan = { toolCallId: "plan-1", name: "Refresh the chat interface", overview: "Keep the changes focused on the conversation and composer.",
  plan: "### Proposed changes\n\n1. Keep model and access controls easy to scan.\n2. Show questions and plan approvals above the composer.\n3. Check keyboard navigation, cancellation, and both themes.\n\nExisting conversations and settings will be preserved.",
  todos: [{ id: "1", content: "Inspect the current chat components", status: "completed" }, { id: "2", content: "Update the interface and verify interactions", status: "pending" }],
};
export const permission = { toolCall: { title: "Run the chat checks", toolCallId: "check-1" }, options: [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "allow-always", name: "Allow always", kind: "allow_always" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" },
] };
export const cursorMock = { calls: [] as { chatId: number; method: string; params: any }[], replies: [] as { chatId: number; id: string; result?: any; error?: any }[], spawns: [] as any[], killed: [] as number[], authFailure: false, authSupported: true };
const channels = new Map<number, Channel<AcpOutput>>();
const prompts = new Map<number, number>();
const callbacks = new Map<string, (result: any) => void>();
const settings = new Map<number, { model: string; mode: string }>();
let nextId = 3000;
let requestId = 0;
const config = (chatId: number) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: settings.get(chatId)!.model, options: [{ value: "auto[]", name: "Auto" }, { value: "sonnet[thinking=true]", name: "Sonnet" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: settings.get(chatId)!.mode, options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }, { value: "ask", name: "Ask" }] },
];
const emit = (chatId: number, body: object) => queueMicrotask(() => channels.get(chatId)?.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) }));
export const cursorNotification = (chatId: number, method: string, params: object) => emit(chatId, { method, params });
export function cursorRequest(chatId: number, method: string, params: object, callback?: (result: any) => void) {
  const id = `cursor-request-${++requestId}`;
  if (callback) callbacks.set(id, callback);
  emit(chatId, { id, method, params });
  return id;
}
export function finishCursor(chatId: number, stopReason = "end_turn") {
  const id = prompts.get(chatId);
  if (id === undefined) return;
  prompts.delete(chatId);
  emit(chatId, { id, result: { stopReason } });
}
function previewFlow(chatId: number) {
  cursorRequest(chatId, "cursor/ask_question", question, answer => {
    if (answer.outcome?.outcome !== "answered") { finishCursor(chatId); return; }
    cursorRequest(chatId, "cursor/create_plan", plan, approval => {
      if (approval.outcome?.outcome !== "accepted") { finishCursor(chatId); return; }
      cursorRequest(chatId, "session/request_permission", permission, () => {
        cursorNotification(chatId, "session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The Cursor chat flow is complete. Questions, plan approval, and tool permission all received a response. This preview did not run any commands." } } });
        finishCursor(chatId);
      });
    });
  });
}
export function mockCursorCommand(cmd: string, args: Record<string, unknown>) {
  if (cmd === "spawn_acp_agent") {
    const chatId = ++nextId;
    channels.set(chatId, args.onOutput as Channel<AcpOutput>);
    cursorMock.spawns.push({ command: args.command, args: args.args });
    settings.set(chatId, { model: "auto[]", mode: "agent" });
    return chatId;
  }
  if (cmd === "kill_acp_agent") { cursorMock.killed.push(Number(args.agentId)); return null; }
  if (cmd !== "write_acp_agent") return null;
  const chatId = Number(args.agentId);
  const message = JSON.parse(String(args.line));
  if (!message.method) {
    cursorMock.replies.push({ chatId, ...message });
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    callback?.(message.result ?? {});
    return null;
  }
  cursorMock.calls.push({ chatId, method: message.method, params: message.params });
  const reply = (result: object) => emit(chatId, { id: message.id, result });
  if (message.method === "initialize") reply({ agentCapabilities: { loadSession: true }, authMethods: cursorMock.authSupported ? [{ id: "cursor_login", name: "Cursor Login" }] : [] });
  else if (message.method === "authenticate") {
    if (cursorMock.authFailure) emit(chatId, { id: message.id, error: { code: -32000, message: "Authentication required" } });
    else reply({});
  } else if (message.method === "session/new" || message.method === "session/load") {
    if (message.method === "session/load") {
      settings.set(chatId, { model: "sonnet[thinking=true]", mode: "plan" });
      cursorNotification(chatId, "session/update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } } });
      cursorNotification(chatId, "session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier answer" } } });
    }
    reply({ sessionId: message.params.sessionId ?? `cursor-session-${chatId}`, configOptions: config(chatId) });
  } else if (message.method === "session/set_config_option") {
    settings.get(chatId)![message.params.configId as "model" | "mode"] = message.params.value;
    reply({ configOptions: config(chatId) });
  } else if (message.method === "session/prompt") {
    prompts.set(chatId, message.id);
    const text = message.params.prompt.map((item: any) => item.text ?? "").join(" ");
    if (!text.includes("wait")) previewFlow(chatId);
  } else if (message.method === "session/cancel") finishCursor(chatId, "cancelled");
  return null;
}
