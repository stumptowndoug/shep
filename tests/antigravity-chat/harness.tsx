import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startChat, closeChat, sendPrompt, cancelTurn, cancelChatStartup, answerPermission, setChatOption } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { pendingRequest } from "../../src/lib/acp/chatModel";
import { useChatStore } from "../../src/stores/useChatStore";
import { useChatModelStore } from "../../src/stores/useChatModelStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { antigravityMock as mock, mockAntigravityCommand, finishAntigravityAuth, antigravityStderr, googleUrl, antigravityPermission } from "./mockAntigravity";
mockIPC((cmd, args) => mockAntigravityCommand(cmd, args as Record<string, unknown>), { shouldMockEvents: true });
const assistant = CODING_ASSISTANTS.find(agent => agent.id === "antigravity")!;
const chat = (id: number) => useChatStore.getState().chats[id];
const calls = (id: number) => mock.calls.filter(call => call.chatId === id);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(check: () => unknown) { const end = performance.now() + 2500; while (!check()) { if (performance.now() > end) throw new Error("Antigravity fixture timed out"); await new Promise(resolve => setTimeout(resolve, 0)); } }
const open = (fullAccess = false, resume = false) => startChat({ assistant, repoPath: "/test/antigravity", mode: fullAccess ? "yolo" : "standard", ...(resume ? { resume: { sessionId: "saved-agy", title: "Saved", startedAt: 1 } } : {}) });

function Harness() {
  const [status, setStatus] = useState("Ready");
  const [results, setResults] = useState<string[]>([]);
  const run = async () => {
    setStatus("Running"); setResults([]);
    const saved = useChatModelStore.getState().models;
    const savedStorage = localStorage.getItem("shep:chat-models");
    const realTimeout = window.setTimeout;
    const realClear = window.clearTimeout;
    const timers = new Map<number, { ms: number; fire: () => void }>();
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: any[]) => {
      const id = realTimeout(fn, ms, ...args);
      if (ms === 60_000 || ms === 300_000) timers.set(id, { ms, fire: () => { if (typeof fn === "function") fn(...args); } });
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = id => { if (id !== undefined) timers.delete(id); realClear(id); };
    const pass = (label: string) => setResults(rows => [...rows, `PASS: ${label}`]);
    try {
      mock.installed = false;
      let missing = false;
      try { await open(); } catch (error) { missing = String(error).includes("Set up chat for this agent"); }
      assert(missing && mock.spawns.length === 0, "Missing runtime spawned a process");
      pass("Missing managed runtime provides setup instructions before spawning");
      mock.installed = true; mock.cachedAuth = false; mock.stallInitialize = false;
      useChatModelStore.setState({ models: {} });
      useTerminalStore.getState().switchProject("/test/antigravity");
      let id = await open();
      await until(() => chat(id).startup?.authUrl);
      assert(mock.spawns.at(-1)?.command === "/test/Antigravity Runtime/agy_acp_server.par", "Managed path lost");
      assert(calls(id).map(call => call.method).join(",") === "initialize,authenticate", "Opened session before authentication");
      assert(calls(id)[1].params.methodId === "oauth-personal", "Wrong sign-in method");
      assert(chat(id).startup!.authUrl === googleUrl && chat(id).turns.length === 0, "Sign-in link entered transcript");
      assert([...timers.values()].some(t => t.ms === 300_000) && ![...timers.values()].some(t => t.ms === 60_000), "Sign-in kept normal startup cutoff");
      pass("Managed binary, personal Google auth, ephemeral sign-in URL, and five-minute deadline");
      antigravityStderr(id, "Open the following link to authenticate the ACP server: https://evil.test/");
      assert(chat(id).startup!.authUrl === googleUrl, "Untrusted link replaced Google URL");
      finishAntigravityAuth(id);
      await until(() => chat(id).status === "ready");
      assert(!chat(id).startup && timers.size === 0, "Auth progress or timer survived startup");
      await until(() => mock.history.some(record => record.sessionId === `antigravity-${id}`));
      assert(mock.history.find(record => record.sessionId === `antigravity-${id}`)?.agentInterface === "chat", "History lost the chat interface");
      pass("Auth completion clears sign-in state and creates a ready session");
      await setChatOption(id, "model", "gemini-pro-agent");
      assert(useChatModelStore.getState().models.antigravity?.id === "gemini-pro-agent", "Model not remembered");
      sendPrompt(id, "wait"); antigravityPermission(id);
      await until(() => pendingRequest(chat(id)));
      answerPermission(id, pendingRequest(chat(id))!.id, "approve");
      await until(() => mock.replies.some(reply => reply.id === "permission"));
      assert(mock.replies.at(-1).result.outcome.optionId === "approve", "Permission id changed");
      cancelTurn(id); await until(() => chat(id).status === "ready");
      assert(chat(id).turns.at(-1)?.stopReason === "cancelled", "Cancel did not finish turn");
      await closeChat(id);
      pass("Models, tool approvals, and Stop use the existing ACP controls");
      mock.cachedAuth = true;
      id = await open(true, true); await until(() => chat(id).status === "ready");
      assert(calls(id).slice(0, 3).map(call => call.method).join(",") === "initialize,authenticate,session/load", "Resume skipped auth");
      assert(!calls(id).some(call => call.method === "session/set_config_option" && call.params.configId === "model"), "Resume replaced the saved model");
      assert(chat(id).options.find(option => option.id === "mode")?.value === "yolo", "Full access did not select the native YOLO mode");
      sendPrompt(id, "wait"); antigravityPermission(id);
      await until(() => mock.replies.length === 2);
      assert(!pendingRequest(chat(id)), "Full access unnecessarily blocked on a tool");
      await closeChat(id);
      pass("Cached credentials, session resume, and Full access remain supported");
      mock.cachedAuth = false;
      id = await open(); await until(() => chat(id).startup?.authUrl);
      cancelChatStartup(id); finishAntigravityAuth(id);
      await until(() => mock.killed.includes(id));
      assert(chat(id).status === "exited" && !chat(id).startup && !calls(id).some(call => call.method === "session/new"), "Cancelled auth continued startup");
      await closeChat(id);
      pass("Cancel sign-in kills the runtime and ignores late authentication");
      id = await open(); await until(() => chat(id).startup?.authUrl);
      await closeChat(id); finishAntigravityAuth(id);
      await until(() => timers.size === 0);
      assert(!chat(id) && mock.killed.includes(id), "Close left a signing-in process alive");
      pass("Closing during sign-in stops the runtime and removes its state");
      id = await open(); await until(() => chat(id).startup?.authUrl);
      finishAntigravityAuth(id, true); await until(() => chat(id).status === "exited");
      assert(chat(id).error?.includes("Google sign-in") && !chat(id).startup, "Auth failure gave unrelated terminal-login advice");
      await closeChat(id);
      pass("Authentication failures offer the correct Google sign-in recovery");
      id = await open(); await until(() => chat(id).startup?.authUrl);
      [...timers.values()].find(timer => timer.ms === 300_000)!.fire();
      assert(chat(id).status === "exited" && chat(id).error?.includes("sign-in timed out") && mock.killed.includes(id), "Sign-in timeout leaked process");
      await closeChat(id);
      mock.stallInitialize = true;
      id = await open(); await until(() => calls(id).length > 0);
      [...timers.values()].find(timer => timer.ms === 60_000)!.fire();
      assert(chat(id).error?.includes("60 seconds"), "Normal initialization lost its timeout");
      await closeChat(id);
      pass("Both sign-in and ordinary startup timeouts stop stalled processes");
      setStatus("All 9 checks passed");
    } catch (error) { setStatus(`FAIL: ${String(error)}`); }
    finally {
      mock.stallInitialize = false;
      for (const id of Object.keys(useChatStore.getState().chats)) await closeChat(Number(id));
      for (const id of timers.keys()) realClear(id);
      window.setTimeout = realTimeout; window.clearTimeout = realClear;
      useChatModelStore.setState({ models: saved });
      if (savedStorage === null) localStorage.removeItem("shep:chat-models"); else localStorage.setItem("shep:chat-models", savedStorage);
    }
  };
  return <main><h1>Antigravity chat checks</h1><button onClick={() => void run()} disabled={status === "Running"}>Run checks</button><p role="status">{status}</p><ul>{results.map(row => <li key={row}>{row}</li>)}</ul></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
