import type { Channel } from "@tauri-apps/api/core";
import type { AcpOutput } from "../../src/lib/tauri";

export const googleUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=preview-only&state=preview-only";
export const antigravityMock = {
  installed: true, installError: false, cachedAuth: false, stallInitialize: false,
  calls: [] as { chatId: number; method: string; params: any }[],
  spawns: [] as any[], killed: [] as number[], replies: [] as any[],
  history: [] as any[],
};
const channels = new Map<number, Channel<AcpOutput>>();
const auth = new Map<number, number>();
const prompts = new Map<number, number>();
const models = new Map<number, string>();
const modes = new Map<number, string>();
let nextId = 4000;
const emit = (id: number, body: object) => queueMicrotask(() => channels.get(id)?.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) }));
export function antigravityStderr(id: number, line: string) {
  channels.get(id)?.onmessage({ event: "stderr", data: line });
}
export function finishAntigravityAuth(id: number, failed = false) {
  const requestId = auth.get(id);
  auth.delete(id);
  if (requestId === undefined) return;
  emit(id, { id: requestId, ...(failed ? { error: { code: -32000, message: "Authentication failed" } } : { result: {} }) });
}
export function finishAntigravityTurn(id: number, stopReason = "end_turn") {
  const requestId = prompts.get(id);
  prompts.delete(id);
  if (requestId !== undefined) emit(id, { id: requestId, result: { stopReason } });
}
export const antigravityPermission = (id: number) => emit(id, {
  id: "permission", method: "session/request_permission", params: {
    toolCall: { toolCallId: "tool-1", title: "Run checks" },
    options: [{ optionId: "approve", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }],
  },
});
const config = (id: number) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: models.get(id), options: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" }] },
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: modes.get(id), options: [{ value: "default", name: "Default" }, { value: "auto_edit", name: "Auto Edit" }, { value: "yolo", name: "YOLO" }] },
];
export function mockAntigravityCommand(cmd: string, args: Record<string, unknown>) {
  if (cmd === "upsert_session_history") { antigravityMock.history.push(args.record); return null; }
  if (cmd === "get_managed_acp_adapter") return antigravityMock.installed ? { command: "/test/Antigravity Runtime/agy_acp_server.par", args: [] } : null;
  if (cmd === "install_managed_acp_adapter") {
    if (antigravityMock.installError) throw new Error("Couldn’t download Antigravity. Check your connection and try again.");
    antigravityMock.installed = true;
    return { command: "/test/Antigravity Runtime/agy_acp_server.par", args: [] };
  }
  if (cmd === "spawn_acp_agent") {
    const id = ++nextId;
    channels.set(id, args.onOutput as Channel<AcpOutput>);
    models.set(id, "gemini-3.8-flash-high");
    modes.set(id, "default");
    antigravityMock.spawns.push({ command: args.command, args: args.args });
    return id;
  }
  if (cmd === "kill_acp_agent") { antigravityMock.killed.push(Number(args.agentId)); return null; }
  if (cmd !== "write_acp_agent") return null;
  const id = Number(args.agentId);
  const message = JSON.parse(String(args.line));
  if (!message.method) { antigravityMock.replies.push(message); return null; }
  antigravityMock.calls.push({ chatId: id, method: message.method, params: message.params });
  const reply = (result: object) => emit(id, { id: message.id, result });
  if (message.method === "initialize" && !antigravityMock.stallInitialize) reply({ agentCapabilities: { loadSession: true }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] });
  else if (message.method === "authenticate") {
    auth.set(id, message.id);
    if (antigravityMock.cachedAuth) finishAntigravityAuth(id);
    else queueMicrotask(() => antigravityStderr(id, "Open the following link to authenticate the ACP server: " + googleUrl));
  } else if (message.method === "session/new" || message.method === "session/load") {
    if (message.method === "session/load") models.set(id, "gemini-pro-agent");
    reply({ sessionId: message.params.sessionId ?? `antigravity-${id}`, configOptions: config(id) });
  } else if (message.method === "session/set_config_option") {
    (message.params.configId === "mode" ? modes : models).set(id, message.params.value);
    reply({ configOptions: config(id) });
  } else if (message.method === "session/prompt") prompts.set(id, message.id);
  else if (message.method === "session/cancel") finishAntigravityTurn(id, "cancelled");
  return null;
}
