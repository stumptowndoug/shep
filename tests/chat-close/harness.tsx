import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { usePty } from "../../src/hooks/usePty";
import { AcpConnection } from "../../src/lib/acp/connection";
import { startChat, sendPrompt } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { useChatStore } from "../../src/stores/useChatStore";
import type { AcpOutput } from "../../src/lib/tauri";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for mocked session");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let nextId = 0;
const channels = new Map<number, Channel<AcpOutput>>();
let writes: string[] = [];
let killCalls = 0;
let historyCalls = 0;
let holdInitialize = false;
let failKill = false;
let killGate = deferred();
let historyGate = deferred();
let writeGate: ReturnType<typeof deferred> | null = null;
let upsertGate: ReturnType<typeof deferred> | null = null;

// All native operations stay inside this fixture. No real agents or files.
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "spawn_acp_agent") {
    const id = ++nextId;
    channels.set(id, args.onOutput as Channel<AcpOutput>);
    return id;
  }
  if (cmd === "write_acp_agent") {
    const message = JSON.parse(String(args.line));
    writes.push(message.method);
    if (writeGate) return writeGate.promise;
    if ((message.method === "initialize" && !holdInitialize) || message.method === "session/new") {
      queueMicrotask(() => channels.get(Number(args.agentId))!.onmessage({
        event: "line",
        data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? {} : { sessionId: `session-${args.agentId}` } }),
      }));
    }
    return;
  }
  if (cmd === "kill_acp_agent") {
    killCalls++;
    if (failKill) return Promise.reject(new Error("Simulated shutdown failure"));
    return killGate.promise;
  }
  if (cmd === "upsert_session_history") return upsertGate?.promise;
  if (cmd === "record_session_history_activity") {
    historyCalls++;
    return historyGate.promise;
  }
}, { shouldMockEvents: true });

function reset() {
  writes = [];
  killCalls = historyCalls = 0;
  holdInitialize = failKill = false;
  writeGate = upsertGate = null;
  killGate = deferred();
  historyGate = deferred();
  useTerminalStore.setState({ projectState: {}, tabActivity: {}, activeProjectPath: null });
  useChatStore.setState({ chats: {} });
  useTerminalStore.getState().switchProject("/test/project");
  useTerminalStore.getState().addPanelTab("launcher");
}

function Harness() {
  const { closeTab } = usePty();
  const [results, setResults] = useState<string[]>([]);
  const [status, setStatus] = useState("Ready");
  const run = async () => {
    setStatus("Running");
    setResults([]);
    const pass = (message: string) => setResults((previous) => [...previous, message]);
    try {
      for (const scenario of ["working", "starting", "shutdown failure", "pending history save"]) {
        reset();
        holdInitialize = scenario === "starting";
        failKill = scenario === "shutdown failure";
        if (scenario === "pending history save") upsertGate = deferred();
        const chatId = await startChat({ assistant: CODING_ASSISTANTS.find((a) => a.id === "claude")!, repoPath: "/test/project", mode: "standard" });
        if (!holdInitialize) await until(() => useChatStore.getState().chats[chatId]?.status === "ready");
        if (scenario === "working") {
          sendPrompt(chatId, "Test pending response");
          await until(() => writes.includes("session/prompt"));
        }
        const tab = useTerminalStore.getState().findTabByPtyId(chatId)!;
        let finished = false;
        const closing = closeTab(tab.id).then(() => { finished = true; });
        const state = useTerminalStore.getState();
        assert(!state.findTabByPtyId(chatId), `${scenario}: tab stayed open`);
        assert(state.projectState["/test/project"].activeTabId !== tab.id, "next tab was not selected");
        assert(!useChatStore.getState().chats[chatId], "conversation state remained mounted");
        assert(!state.tabActivity[chatId], "activity state remained");
        assert(!finished && killCalls === 1, "cleanup was not pending");
        state.switchProject("/test/other-project");
        state.addPanelTab("git");
        channels.get(chatId)!.onmessage({ event: "line", data: JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late output" } } } }) });
        channels.get(chatId)!.onmessage({ event: "exit", data: { code: 0, stderr: "" } });
        assert(!useChatStore.getState().chats[chatId], "late output revived the chat");
        await closeTab(tab.id);
        assert(killCalls === 1, "duplicate close killed twice");
        killGate.resolve();
        if (upsertGate) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          assert(historyCalls === 0, "end history overtook the pending session save");
          upsertGate.resolve();
        }
        if (!holdInitialize) {
          await until(() => historyCalls === 1);
          assert(!finished, "fixture did not hold the history write");
        }
        historyGate.resolve();
        await closing;
        assert(useTerminalStore.getState().projectState["/test/other-project"].tabs.length === 1, "cleanup changed the newly selected project");
        pass(`PASS: ${scenario} — closes immediately, safely completes cleanup`);
      }

      reset();
      writeGate = deferred();
      let notifications = 0;
      const connection = await AcpConnection.spawn("mock", [], "/test", { onRequest: async () => null, onNotification: () => { notifications++; }, onExit: () => {} });
      let rejected = false;
      const pending = connection.request("first", {}).catch(() => { rejected = true; });
      connection.notify("second", {});
      await until(() => writes.length === 1);
      assert(writes[0] === "first", "writes were not serialized");
      const closing = connection.kill();
      await pending;
      assert(rejected && killCalls === 1, "close waited for the blocked write or agent exit");
      channels.get(connection.id)!.onmessage({ event: "line", data: JSON.stringify({ method: "late", params: {} }) });
      assert(notifications === 0, "closed connection delivered late notifications");
      writeGate.resolve();
      killGate.resolve();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(writes.length === 1, "queued write was sent after close");
      pass("PASS: blocked input — close bypasses queued writes and rejects pending requests");
      setStatus("All 5 checks passed");
    } catch (error) {
      setStatus(`FAIL: ${error instanceof Error ? error.message : error}`);
    } finally {
      killGate.resolve();
      historyGate.resolve();
      writeGate?.resolve();
      upsertGate?.resolve();
    }
  };
  return <main><h1>Chat close regression checks</h1><p>Mock native cleanup while exercising the real session, connection, store, and tab-close code.</p><button disabled={status === "Running"} onClick={() => void run()}>Run checks</button><p role="status">{status}</p><ul>{results.map((result) => <li key={result}>{result}</li>)}</ul></main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
