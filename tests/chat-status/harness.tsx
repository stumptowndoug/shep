// Exercises the real ACP session/store/sidebar path; only the native transport is mocked.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { AcpOutput } from "../../src/lib/tauri";
import { startChat, closeChat, sendPrompt, cancelTurn, cancelChatStartup, answerPermission, answerCursorRequest } from "../../src/lib/acp/chatSessions";
import { pendingRequest } from "../../src/lib/acp/chatModel";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import AgentSessionList from "../../src/components/sidebar/AgentSessionList";
import { useChatStore } from "../../src/stores/useChatStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { useThemeStore } from "../../src/stores/useThemeStore";
import { useThemeApplicator } from "../../src/hooks/useThemeApplicator";
import { cursorMock, mockCursorCommand, cursorRequest, cursorNotification, finishCursor, question, plan, permission } from "../cursor-chat/mockCursor";
import { antigravityMock, mockAntigravityCommand, finishAntigravityAuth } from "../antigravity-chat/mockAntigravity";
import "../../src/styles/globals.css";

const path = "/test/chat-status";
const channels = new Map<number, Channel<AcpOutput>>();
const prompts = new Map<number, number>();
let failNextPrompt = false;
let rejectCancellation = false;
const emit = (id: number, body: object) => queueMicrotask(() => channels.get(id)?.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", ...body }) }));
mockWindows("main");
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  const id = Number(args?.agentId);
  if (cmd === "write_acp_agent") {
    const message = JSON.parse(String(args.line));
    if (message.method === "session/prompt") {
      prompts.set(id, message.id);
      if (failNextPrompt) {
        failNextPrompt = false;
        emit(id, { id: message.id, error: { code: -32000, message: "Account quota exceeded" } });
        return null;
      }
    }
    if (message.method === "session/cancel" && rejectCancellation) {
      emit(id, { id: prompts.get(id), error: { code: -32000, message: "Request cancelled" } });
      return null;
    }
  }
  const antigravity = cmd.includes("managed_acp") || (cmd === "spawn_acp_agent" ? String(args.command).includes("agy_acp") : id >= 4000);
  const result = antigravity ? mockAntigravityCommand(cmd, args) : mockCursorCommand(cmd, args);
  if (cmd === "spawn_acp_agent") channels.set(result as number, args.onOutput as Channel<AcpOutput>);
  return result;
}, { shouldMockEvents: true });
const chat = (id: number) => useChatStore.getState().chats[id];
const activity = (id: number) => useTerminalStore.getState().tabActivity[id];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(check: () => unknown, message = "Fixture timed out") {
  const end = performance.now() + 3000;
  while (!check()) { if (performance.now() > end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 0)); }
}
async function open(agent = "cursor", fullAccess = false) {
  useTerminalStore.getState().switchProject(path);
  const id = await startChat({ assistant: CODING_ASSISTANTS.find(entry => entry.id === agent)!, repoPath: path, mode: fullAccess ? "yolo" : "standard" });
  const tab = useTerminalStore.getState().findTabByPtyId(id)!;
  useTerminalStore.getState().updateTab(tab.id, { label: `${agent} ${id}` });
  return id;
}
async function close(id: number) {
  const tab = useTerminalStore.getState().findTabByPtyId(id);
  await closeChat(id);
  if (tab) useTerminalStore.getState().removeTab(tab.id);
}
function indicator(id: number) {
  const tab = useTerminalStore.getState().findTabByPtyId(id);
  return [...document.querySelectorAll<HTMLElement>(".agent-session-row")]
    .find(row => row.querySelector(".agent-session-row__title")?.textContent === tab?.label)
    ?.querySelector<HTMLElement>(".activity-indicator");
}
async function expectIndicator(id: number, state: "idle" | "working" | "attention", reason?: string) {
  await until(() => indicator(id)?.classList.contains(`activity-indicator--${state}`), `Expected ${id} to show ${state}; found ${indicator(id)?.className}`);
  const node = indicator(id)!;
  const style = getComputedStyle(node);
  assert(!/--(done|failed|running|stuck|active)\b/.test(node.className), "Chat rendered an obsolete status");
  if (reason) assert(node.title.includes(reason), `Tooltip missing ${reason}: ${node.title}`);
  if (state === "idle") assert(style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderTopWidth === "0px", "Idle still has a visible marker");
  if (state !== "idle") {
    const probe = document.createElement("span");
    probe.style.color = state === "working" ? "var(--accent)" : "var(--warn)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    assert((state === "working" ? style.borderTopColor : style.backgroundColor) === color, `${state} does not use its theme color`);
    if (state === "working") assert(style.animationName === "activity-spin", "Working marker is not a spinner");
  }
}
async function begin(id: number) {
  const previous = prompts.get(id);
  sendPrompt(id, "wait for this status check");
  await until(() => prompts.get(id) !== previous);
  await expectIndicator(id, "working");
}
async function request(id: number, method: string, params: object) {
  cursorRequest(id, method, params);
  await until(() => pendingRequest(chat(id)));
  await expectIndicator(id, "attention");
  return pendingRequest(chat(id))!;
}
async function end(id: number) {
  finishCursor(id);
  await until(() => chat(id).status === "ready");
  await expectIndicator(id, "idle");
}
function SessionRows() {
  const projects = useTerminalStore(s => s.projectState);
  const activePath = useTerminalStore(s => s.activeProjectPath);
  const sessions = Object.values(projects).flatMap(project => project.tabs.flatMap(tab => tab.kind === "assistant" ? [{ tab, projectName: "shep", branchName: "design/status" }] : []));
  return <AgentSessionList sessions={sessions} activeRepoPath={activePath} activeTabId={activePath ? projects[activePath]?.activeTabId : null} labelMode="title" onSelectSession={(repo, id) => { useTerminalStore.getState().switchProject(repo); useTerminalStore.getState().setActiveTab(id); }} />;
}
function Harness() {
  useThemeApplicator();
  const [status, setStatus] = useState("Ready");
  const [results, setResults] = useState<string[]>([]);
  const run = async () => {
    setStatus("Running"); setResults([]);
    let count = 0;
    const pass = (text: string) => { count++; setResults(rows => [...rows, `PASS: ${text}`]); };
    try {
      for (const theme of ["catppuccin", "github-light"]) {
        useThemeStore.getState().setTheme(theme);
        antigravityMock.stallInitialize = true;
        let id = await open("antigravity");
        await expectIndicator(id, "working", "Starting agent");
        await close(id);
        antigravityMock.stallInitialize = false;
        pass(`${theme}: startup uses the theme accent spinner`);

        id = await open(); await until(() => chat(id).status === "ready");
        await expectIndicator(id, "idle");
        await begin(id);
        for (const background of [false, true]) {
          if (background) useTerminalStore.getState().addPanelTab("launcher");
          let item = await request(id, "session/request_permission", permission);
          await expectIndicator(id, "attention", "Waiting for permission");
          answerPermission(id, item.id, background ? "reject-once" : "allow-once");
          await until(() => !pendingRequest(chat(id)));
          await expectIndicator(id, "working");
          assert(!activity(id).bell, "Permission left sticky notification attention");
          item = await request(id, "cursor/ask_question", question);
          await expectIndicator(id, "attention", "Waiting for your answer");
          answerCursorRequest(id, item.id, { outcome: "skipped" });
          await until(() => !pendingRequest(chat(id)));
          await expectIndicator(id, "working");
          item = await request(id, "cursor/create_plan", plan);
          await expectIndicator(id, "attention", "Waiting for plan approval");
          answerCursorRequest(id, item.id, { outcome: background ? "rejected" : "accepted" });
          await until(() => !pendingRequest(chat(id)));
          await expectIndicator(id, "working");
          pass(`${theme}: ${background ? "background" : "selected"} permissions, questions, and plans clear when resolved`);
        }
        await end(id);
        assert(!activity(id).bell, "Background completion raised attention");
        pass(`${theme}: background completion has no indicator`);

        failNextPrompt = true;
        sendPrompt(id, "wait for a failed request");
        await until(() => chat(id).status === "ready");
        await expectIndicator(id, "attention", "Account quota exceeded");
        const tab = useTerminalStore.getState().findTabByPtyId(id)!;
        useTerminalStore.getState().setActiveTab(tab.id);
        useTerminalStore.getState().clearTabBell(id);
        await expectIndicator(id, "attention");
        await begin(id); await end(id);
        pass(`${theme}: prompt error stays yellow until retry and clears after recovery`);

        for (const reject of [false, true]) {
          await begin(id);
          await request(id, "session/request_permission", permission);
          rejectCancellation = reject;
          cancelTurn(id);
          await expectIndicator(id, "idle");
          await until(() => chat(id).status === "ready");
          await expectIndicator(id, "idle");
          assert(chat(id).turns.at(-1)?.stopReason === "cancelled", "Stop was reported as an error");
        }
        rejectCancellation = false;
        pass(`${theme}: Stop clears pending attention, including adapters that reject cancellation`);

        await begin(id);
        cursorNotification(id, "session/update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Which approach do you prefer?" } } });
        await end(id);
        pass(`${theme}: ordinary text questions finish quietly without guessing intent`);
        channels.get(id)!.onmessage({ event: "exit", data: { code: 2, stderr: "Adapter failed" } });
        await expectIndicator(id, "attention", "exited with code 2");
        await close(id);
        pass(`${theme}: process failure uses yellow and close removes activity`);
        assert(!activity(id), "Close retained status");

        cursorMock.authFailure = true;
        id = await open(); await until(() => chat(id).status === "exited");
        await expectIndicator(id, "attention"); await close(id);
        cursorMock.authFailure = false;
        id = await open(); await until(() => chat(id).status === "ready");
        channels.get(id)!.onmessage({ event: "exit", data: { code: 0, stderr: "" } });
        await expectIndicator(id, "idle"); await close(id);
        pass(`${theme}: startup failure is yellow; clean exit is quiet`);

        id = await open("antigravity"); await until(() => chat(id).startup?.authUrl);
        await expectIndicator(id, "attention", "Google sign-in");
        finishAntigravityAuth(id); await until(() => chat(id).status === "ready");
        await expectIndicator(id, "idle"); await close(id);
        id = await open("antigravity"); await until(() => chat(id).startup?.authUrl);
        cancelChatStartup(id); await expectIndicator(id, "idle"); await close(id);
        pass(`${theme}: Google sign-in needs you; completion or cancellation clears it`);

        id = await open("cursor", true); await until(() => chat(id).status === "ready");
        await begin(id);
        const rpc = cursorRequest(id, "session/request_permission", permission);
        await until(() => cursorMock.replies.some(reply => reply.id === rpc));
        await expectIndicator(id, "working");
        await request(id, "cursor/create_plan", plan);
        await close(id); await until(() => !indicator(id));
        pass(`${theme}: Full access skips tool attention, still waits for decisions, and closes cleanly`);
      }
      setStatus(`All ${count} checks passed`);
    } catch (error) { setStatus(`FAIL: ${String(error)}`); }
    finally {
      cursorMock.authFailure = false; antigravityMock.stallInitialize = false; rejectCancellation = false;
      for (const id of Object.keys(useChatStore.getState().chats)) await close(Number(id));
    }
  };
  return <main style={{ display: "flex", height: "100%", overflow: "auto", gap: 32, padding: 32 }}>
    <aside style={{ width: 280, flex: "none", background: "var(--sidebar-bg)", borderRadius: 12, padding: 8 }}><SessionRows /></aside>
    <section><h1>ACP chat status checks</h1><p>Real session handling and sidebar rows, using a mock native ACP transport.</p>
      <button className="btn" onClick={() => void run()} disabled={status === "Running"}>Run checks</button>
      <p role="status">{status}</p><ul>{results.map(row => <li key={row}>{row}</li>)}</ul>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
