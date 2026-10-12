// Real composer, reducer, session lifecycle and transport; no agent processes.
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import ChatView from "../../src/components/chat/ChatView";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { startChat, closeChat } from "../../src/lib/acp/chatSessions";
import { useChatStore } from "../../src/stores/useChatStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { useThemeStore } from "../../src/stores/useThemeStore";
import { useThemeApplicator } from "../../src/hooks/useThemeApplicator";
import type { AcpOutput } from "../../src/lib/tauri";
import "../../src/styles/globals.css";

const params = new URLSearchParams(location.search);
const chatId = 7001;
const repoPath = "/test/queue";
let channel: Channel<AcpOutput>;
let sessionRequest: number;
let activeRequest: number | undefined;
const requests: { type: string; text: string }[][] = [];
const emit = (body: object) => queueMicrotask(() => channel.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) }));

export function finish(stopReason = "end_turn") {
  const id = activeRequest;
  activeRequest = undefined;
  emit({ id, result: { stopReason } });
}
export function failPrompt() {
  const id = activeRequest;
  activeRequest = undefined;
  emit({ id, error: { code: -32000, message: "Simulated provider failure" } });
}
export function releaseStartup() { emit({ id: sessionRequest, result: { sessionId: "queue-session" } }); }
export function failStartup() { emit({ id: sessionRequest, error: { code: -32000, message: "Simulated startup failure" } }); }
export function exitAgent() { channel.onmessage({ event: "exit", data: { code: 1, stderr: "Simulated crash" } }); }
export function snapshot() { return { requests, chat: useChatStore.getState().chats[chatId] }; }
export function close() { return closeChat(chatId); }

mockWindows("main");
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "get_managed_acp_adapter") return { command: `/test/${String(args.adapter)}-acp`, args: [] };
  if (cmd === "spawn_acp_agent") { channel = args.onOutput as Channel<AcpOutput>; return chatId; }
  if (cmd !== "write_acp_agent") return null;
  const message = JSON.parse(String(args.line));
  if (message.method === "initialize") emit({ id: message.id, result: {} });
  if (message.method === "session/new") {
    sessionRequest = message.id;
    if (params.get("startup") !== "hold") releaseStartup();
  }
  if (message.method === "session/prompt") {
    activeRequest = message.id;
    requests.push(message.params.prompt);
  }
  if (message.method === "session/cancel" && params.get("cancel") !== "hold") finish("cancelled");
  return null;
}, { shouldMockEvents: true });

function Harness() {
  useThemeApplicator();
  return <ChatView chatId={chatId} assistantId="pi" repoPath={repoPath} fullAccess={false} />;
}
useThemeStore.getState().setTheme(params.get("theme") ?? "catppuccin");
useTerminalStore.getState().switchProject(repoPath);
void startChat({ assistant: CODING_ASSISTANTS.find(agent => agent.id === "pi")!, repoPath, mode: "standard" })
  .then(() => createRoot(document.getElementById("root")!).render(<Harness />));
