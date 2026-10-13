import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import ChatView from "../../src/components/chat/ChatView";
import { startChat, sendPrompt, cancelTurn } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { useChatStore } from "../../src/stores/useChatStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { useThemeStore } from "../../src/stores/useThemeStore";
import { useThemeApplicator } from "../../src/hooks/useThemeApplicator";
import type { AcpOutput } from "../../src/lib/tauri";
import "../../src/styles/globals.css";

let channel: Channel<AcpOutput>;
let promptId: number;
let requestId = 100;
const cannotResume = new URLSearchParams(location.search).has("cannotResume");
const writes: {id?: number; method?: string; params?: unknown; result?: unknown}[] = [];
const emit = (body: object) => channel.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) });
const update = (sessionId: string, value: object) => emit({ method: "session/update", params: { sessionId, update: value } });
mockWindows("main");
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "get_managed_acp_adapter") return { command: "mock-acp", args: [] };
  if (cmd === "spawn_acp_agent") { channel = args.onOutput as Channel<AcpOutput>; return 1000; }
  if (cmd === "write_acp_agent") {
    const message = JSON.parse(String(args.line));
    writes.push(message);
    if (message.method === "initialize") queueMicrotask(() => emit({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !cannotResume } } }));
    if (message.method === "session/new" || message.method === "session/load") queueMicrotask(() => {
      if (message.method === "session/load") {
        spawn("reviewer", "Reviewer");
        update("reviewer", { sessionUpdate: "agent_message_chunk", messageId: "same", content: { type: "text", text: "Restored child result" } });
        finish("reviewer");
      }
      if (cannotResume) {
        spawn("reviewer", "Reviewer", "fresh-root");
        update("reviewer", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New session child" } });
      }
      emit({ id: message.id, result: { sessionId: cannotResume ? "fresh-root" : "root" } });
    });
    if (message.method === "session/prompt") promptId = message.id;
  }
  return null;
}, { shouldMockEvents: true });

function spawn(id: string, name: string, parent = "root") {
  update(parent, { sessionUpdate: "subagent_spawned", subagentSessionId: id, name, task: `Check ${name.toLowerCase()} findings`, capabilities: {} });
}
function finish(id: string, parent = "root") { update(parent, { sessionUpdate: "subagent_state_update", subagentSessionId: id, state: "completed" }); }

function Harness() {
  useThemeApplicator();
  const [id, setId] = useState<number>();
  const [reply, setReply] = useState("");
  const chat = useChatStore(state => id === undefined ? undefined : state.chats[id]);
  const activity = useTerminalStore(state => id === undefined ? undefined : state.tabActivity[id]?.agentState);
  const open = async (resume = false) => {
    useTerminalStore.getState().switchProject("/test/workers");
    const next = await startChat({ assistant: CODING_ASSISTANTS.find(agent => agent.id === "claude")!, repoPath: "/test/workers", mode: "standard", ...(resume ? {resume: {sessionId: "root", title: "Restored", startedAt: 1}} : {}) });
    setId(next);
  };
  return <>
    <div style={{height: 95, display: "flex", gap: 5, flexWrap: "wrap", alignContent: "start", padding: 8}}>
      <button onClick={() => void open()}>Open chat</button>
      <button onClick={() => void open(true)}>Resume chat</button>
      <button onClick={() => {
        sendPrompt(id!, "Review this change with two agents");
        spawn("reviewer", "Reviewer"); spawn("tests", "Test investigator");
        for (const [sessionId, text] of [["root", "I delegated the review."], ["reviewer", "Reviewing cancellation behavior."], ["tests", "Checking the queue tests."]]) {
          update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "same", content: { type: "text", text } });
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "same-tool", title: `${sessionId} tool`, kind: "read", status: "in_progress" });
        }
      }}>Delegate</button>
      <button onClick={() => emit({ id: promptId, result: { stopReason: "end_turn" } })}>Finish parent</button>
      <button onClick={() => cancelTurn(id!)}>Cancel parent</button>
      <button onClick={() => finish("reviewer")}>Finish reviewer</button>
      <button onClick={() => finish("tests")}>Finish tests</button>
      <button onClick={() => spawn("nested", "Nested agent", "reviewer")}>Spawn nested</button>
      <button onClick={() => emit({ id: ++requestId, method: "session/request_permission", params: { sessionId: "reviewer", toolCall: { title: "Run checks" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } })}>Child permission</button>
      <button onClick={() => setReply(JSON.stringify(writes))}>Inspect replies</button>
      <button onClick={() => channel.onmessage({event: "exit", data: {code: 1, stderr: "Connection lost"}})}>Exit adapter</button>
      <button onClick={() => useThemeStore.getState().setTheme("github-light")}>Light theme</button>
      <output data-testid="state">{chat?.status} · {activity}</output>
      <output data-testid="replies" style={{display: "none"}}>{reply}</output>
    </div>
    <div style={{position: "absolute", top: 100, bottom: 0, left: 0, right: 0}}>
      {id !== undefined && <ChatView chatId={id} assistantId="claude" repoPath="/test/workers" fullAccess={false} />}
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
