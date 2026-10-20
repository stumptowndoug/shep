import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import ChatView from "../../src/components/chat/ChatView";
import { startChat, sendPrompt } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { useChatStore } from "../../src/stores/useChatStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import type { AcpOutput } from "../../src/lib/tauri";
import "../../src/styles/globals.css";

let channel: Channel<AcpOutput>;
let promptId: number;
let fileOutput = "server listening on :5173\n";
const writes: {id?: number; method?: string; params?: Record<string, unknown>; result?: unknown}[] = [];
const outputReads: string[] = [];
const emit = (body: object) => channel.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) });
const update = (value: object, sessionId = "root") => emit({ method: "session/update", params: { sessionId, update: value } });
mockWindows("main");
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "get_managed_acp_adapter") return { command: "mock-acp", args: [] };
  if (cmd === "spawn_acp_agent") { channel = args.onOutput as Channel<AcpOutput>; return 2000; }
  if (cmd === "read_task_output") { outputReads.push(String(args.path)); return { text: fileOutput, truncated: false }; }
  if (cmd === "write_acp_agent") {
    const message = JSON.parse(String(args.line));
    writes.push(message);
    if (message.method === "initialize") queueMicrotask(() => emit({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    if (message.method === "session/new") queueMicrotask(() => emit({ id: message.id, result: { sessionId: "root" } }));
    if (message.method === "session/prompt") promptId = message.id;
    if (message.method === "_session/async_task/stop") queueMicrotask(() => {
      update({ sessionUpdate: "async_task_state_update", asyncTaskId: message.params.asyncTaskId, state: "stopped" });
      emit({ id: message.id, result: { stopped: true } });
    });
  }
  return null;
}, { shouldMockEvents: true });

/** Claude: the call returns at once, and the command's output goes to a file. */
function startServer() {
  update({ sessionUpdate: "tool_call", toolCallId: "bash-dev", title: "pnpm dev", kind: "execute", status: "in_progress", rawInput: { command: "pnpm dev", run_in_background: true } });
  update({ sessionUpdate: "tool_call_update", toolCallId: "bash-dev", status: "completed", _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } });
  update({ sessionUpdate: "async_task_spawned", asyncTaskId: "task-dev", name: "Bash", taskType: "shell", description: "pnpm dev", canStop: true,
    toolCallId: "bash-dev", outputFilePath: "/tmp/claude-501/tasks/task-dev.output" });
}

/** Codex: the command's output streams to its tool call. */
function startWatcher() {
  update({ sessionUpdate: "tool_call", toolCallId: "watch", title: "cargo watch", kind: "execute", status: "in_progress", rawInput: { command: "cargo watch" } });
  update({ sessionUpdate: "async_task_spawned", asyncTaskId: "task-watch", name: "cargo watch", taskType: "shell", canStop: true, toolCallId: "watch" });
  for (const line of ["Compiling shep\n", "Finished dev\n"]) {
    update({ sessionUpdate: "tool_call_update", toolCallId: "watch", _meta: { terminal_output_delta: { data: line, terminal_id: "watch" } } });
  }
}

function Harness() {
  const [id, setId] = useState<number>();
  const [reply, setReply] = useState("");
  const chat = useChatStore(state => id === undefined ? undefined : state.chats[id]);
  const open = async () => {
    useTerminalStore.getState().switchProject("/test/tasks");
    setId(await startChat({ assistant: CODING_ASSISTANTS.find(agent => agent.id === "claude")!, repoPath: "/test/tasks", mode: "standard" }));
  };
  return <>
    <div style={{height: 95, display: "flex", gap: 5, flexWrap: "wrap", alignContent: "start", padding: 8}}>
      <button onClick={() => void open()}>Open chat</button>
      <button onClick={() => { sendPrompt(id!, "Start the dev server"); startServer(); }}>Start server</button>
      <button onClick={() => { sendPrompt(id!, "Watch the build"); startWatcher(); }}>Start watcher</button>
      <button onClick={() => emit({ id: promptId, result: { stopReason: "end_turn" } })}>Finish turn</button>
      <button onClick={() => { fileOutput += "GET / 200\n"; }}>More server output</button>
      <button onClick={() => {
        sendPrompt(id!, "Explain the codebase");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n") } });
        emit({ id: promptId, result: { stopReason: "end_turn" } });
      }}>Long answer</button>
      <button onClick={() => update({ sessionUpdate: "async_task_state_update", asyncTaskId: "task-watch", state: "completed" })}>Finish watcher</button>
      <button onClick={() => setReply(JSON.stringify({ writes, outputReads }))}>Inspect</button>
      <button onClick={() => channel.onmessage({event: "exit", data: {code: 1, stderr: "Connection lost"}})}>Exit adapter</button>
      <output data-testid="state">{chat?.status}</output>
      <output data-testid="replies" style={{display: "none"}}>{reply}</output>
    </div>
    <div style={{position: "absolute", top: 100, bottom: 0, left: 0, right: 0}}>
      {id !== undefined && <ChatView chatId={id} assistantId="claude" repoPath="/test/tasks" fullAccess={false} />}
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
