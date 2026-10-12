import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startChat, closeChat, sendPrompt } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { useChatStore } from "../../src/stores/useChatStore";
import { chatDraftKey, useChatDraftStore } from "../../src/stores/useChatDraftStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { turnStopMessage } from "../../src/lib/acp/chatPresentation";
import type { AcpOutput } from "../../src/lib/tauri";

let nextId = 4000;
let releaseSession: (() => void) | undefined;
let holdSession = true;
let failPrompt = false;
let canResume = true;
const channels = new Map<number, Channel<AcpOutput>>();
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "get_managed_acp_adapter") return { command: `/test/${String(args.adapter)}-acp`, args: [] };
  if (cmd === "spawn_acp_agent") { channels.set(++nextId, args.onOutput as Channel<AcpOutput>); return nextId; }
  if (cmd !== "write_acp_agent") return null;
  const id = Number(args.agentId);
  const message = JSON.parse(String(args.line));
  const emit = (body: object) => queueMicrotask(() => channels.get(id)?.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) }));
  if (message.method === "initialize") emit({ result: { agentCapabilities: { loadSession: canResume } } });
  if (message.method === "session/new" || message.method === "session/load") {
    const reply = () => emit({ result: { sessionId: message.params.sessionId ?? `session-${id}` } });
    if (holdSession) releaseSession = reply; else reply();
  }
  if (message.method === "session/prompt") emit(failPrompt ? { error: { code: -32603, message: "Preview provider unavailable" } } : { result: { stopReason: "max_turn_requests" } });
  return null;
}, { shouldMockEvents: true });
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 0)); }
}
const repoPath = "/test/chat-sessions";
const assistant = CODING_ASSISTANTS.find(agent => agent.id === "pi")!;
const open = (sessionId?: string) => startChat({ assistant, repoPath, mode: "standard", ...(sessionId ? { resume: { sessionId, title: "Restored", startedAt: 1 } } : {}) });
function Harness() {
  const [status, setStatus] = useState("Ready");
  const [results, setResults] = useState<string[]>([]);
  const run = async () => {
    setStatus("Running"); setResults([]);
    holdSession = true; failPrompt = false; canResume = true; releaseSession = undefined;
    const pass = (name: string) => setResults(rows => [...rows, `PASS: ${name}`]);
    try {
      useTerminalStore.getState().switchProject(repoPath);
      const id = await open();
      await until(() => Boolean(releaseSession));
      const pending = useChatStore.getState().chats[id].draftKey!;
      useChatDraftStore.getState().setDraft(pending, "Typed while starting");
      releaseSession!(); holdSession = false;
      await until(() => useChatStore.getState().chats[id]?.status === "ready");
      const stable = chatDraftKey("pi", repoPath, `session-${id}`);
      assert(useChatStore.getState().chats[id].draftKey === stable, "Provider session was not used for draft identity");
      assert(useChatDraftStore.getState().drafts[stable] === "Typed while starting", "Startup lost the draft");
      pass("Startup preserves drafts when the provider session id arrives");
      await closeChat(id);
      assert(!sendPrompt(id, "Should remain unsent"), "Closed chat accepted a prompt");
      useChatDraftStore.setState({ drafts: {} });
      const resumed = await open(`session-${id}`);
      await until(() => useChatStore.getState().chats[resumed]?.status === "ready");
      assert(useChatDraftStore.getState().drafts[useChatStore.getState().chats[resumed].draftKey!] === "Typed while starting", "Resume after reload lost the draft");
      pass("Closing and resuming after a store reload restores the unsent message");
      assert(sendPrompt(resumed, "Hit the turn limit"), "Ready chat rejected a prompt");
      await until(() => Boolean(useChatStore.getState().chats[resumed].turns[0]?.endedAt));
      assert(turnStopMessage(useChatStore.getState().chats[resumed].turns[0])?.includes("continue"), "Turn limit message missing");
      failPrompt = true;
      sendPrompt(resumed, "Fail the prompt");
      await until(() => Boolean(useChatStore.getState().chats[resumed].turns[1]?.endedAt));
      const failed = useChatStore.getState().chats[resumed].turns[1];
      assert(turnStopMessage(failed) === "Preview provider unavailable", "Error missing from turn");
      assert(!failed.items.some(item => item.kind === "notice"), "Error duplicated as a notice");
      pass("Prompt completion explains limits and preserves provider errors once");
      await closeChat(resumed);
      canResume = false;
      const replacement = await open(`session-${id}`);
      await until(() => useChatStore.getState().chats[replacement]?.status === "ready");
      const replacementKey = useChatStore.getState().chats[replacement].draftKey!;
      assert(replacementKey !== stable && useChatDraftStore.getState().drafts[replacementKey] === "Typed while starting", "Fallback to a new session lost the draft");
      pass("Agents without session/load preserve drafts in the replacement chat");
      setStatus("All 4 checks passed");
    } catch (error) { setStatus(`FAIL: ${error instanceof Error ? error.message : error}`); }
    finally {
      for (const id of Object.keys(useChatStore.getState().chats)) await closeChat(Number(id));
      for (const key of Object.keys(useChatDraftStore.getState().drafts)) useChatDraftStore.getState().setDraft(key, "");
    }
  };
  return <main><h1>Chat session regression checks</h1><p>Mock ACP responses; no real agents are launched.</p><button onClick={() => void run()} disabled={status === "Running"}>Run checks</button><p role="status">{status}</p><ul>{results.map(row => <li key={row}>{row}</li>)}</ul></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
