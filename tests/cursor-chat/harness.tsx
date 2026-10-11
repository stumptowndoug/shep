import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startChat, closeChat, sendPrompt, cancelTurn, answerPermission, answerCursorRequest, setChatOption } from "../../src/lib/acp/chatSessions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { pendingRequest } from "../../src/lib/acp/chatModel";
import { useChatStore } from "../../src/stores/useChatStore";
import { useChatModelStore } from "../../src/stores/useChatModelStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import { cursorMock, mockCursorCommand, cursorRequest, cursorNotification, finishCursor, question, plan, permission } from "./mockCursor";

mockIPC((cmd, args) => mockCursorCommand(cmd, args as Record<string, unknown>), { shouldMockEvents: true });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => unknown) { const end = performance.now() + 2500; while (!predicate()) { if (performance.now() > end) throw new Error("Timed out waiting for Cursor fixture"); await new Promise(resolve => setTimeout(resolve, 0)); } }
const chat = (id: number) => useChatStore.getState().chats[id];
const reply = (id: string) => cursorMock.replies.find(reply => reply.id === id);
const calls = (id: number) => cursorMock.calls.filter(call => call.chatId === id);
const assistant = CODING_ASSISTANTS.find(agent => agent.id === "cursor")!;
async function open(fullAccess = false, resume = false) {
  const id = await startChat({ assistant, repoPath: "/test/cursor-chat", mode: fullAccess ? "yolo" : "standard", ...(resume ? { resume: { sessionId: "saved-cursor", title: "Saved", startedAt: 1 } } : {}) });
  await until(() => chat(id)?.status !== "starting");
  return id;
}
async function ask(id: number, method: string, params: object) {
  const requestId = cursorRequest(id, method, params);
  await until(() => pendingRequest(chat(id)) || reply(requestId));
  return requestId;
}
function Harness() {
  const [status, setStatus] = useState("Ready");
  const [results, setResults] = useState<string[]>([]);
  const run = async () => {
    setStatus("Running"); setResults([]);
    const savedModels = useChatModelStore.getState().models;
    const savedStorage = localStorage.getItem("shep:chat-models");
    const pass = (label: string) => setResults(rows => [...rows, `PASS: ${label}`]);
    try {
      cursorMock.authFailure = false; cursorMock.authSupported = true;
      useChatModelStore.setState({ models: {} });
      useTerminalStore.getState().switchProject("/test/cursor-chat");
      let id = await open();
      assert(cursorMock.spawns.at(-1)?.command === "cursor-agent" && cursorMock.spawns.at(-1)?.args[0] === "acp", "Wrong Cursor executable");
      assert(calls(id).slice(0, 3).map(call => call.method).join(",") === "initialize,authenticate,session/new", "Wrong startup order");
      assert(calls(id)[1].params.methodId === "cursor_login", "Wrong auth method");
      pass("Native Cursor registration and initialize → authenticate → new session");
      await setChatOption(id, "mode", "ask");
      assert(useTerminalStore.getState().findTabByPtyId(id)?.sessionMode === "standard", "Cursor mode changed Shep permission policy");
      await setChatOption(id, "model", "sonnet[thinking=true]");
      assert(useChatModelStore.getState().models.cursor?.id === "sonnet[thinking=true]", "Model choice not saved");
      pass("Model memory and Cursor modes stay separate from permission policy");
      sendPrompt(id, "wait");
      let requestId = await ask(id, "session/request_permission", permission);
      const approval = pendingRequest(chat(id))!;
      answerPermission(id, approval.id, "allow-once");
      await until(() => reply(requestId));
      assert(reply(requestId)!.result.outcome.optionId === "allow-once", "Permission option id was changed");
      pass("Manual tool permission preserves Cursor’s exact option id");
      requestId = await ask(id, "cursor/ask_question", question);
      const questionItem = pendingRequest(chat(id))!;
      assert(!answerCursorRequest(id, questionItem.id, { outcome: "answered", answers: [] }), "Incomplete answer was accepted");
      answerCursorRequest(id, questionItem.id, { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["chat"] }, { questionId: "checks", selectedOptionIds: ["unit", "visual"] }] });
      await until(() => reply(requestId));
      assert(reply(requestId)!.result.outcome.answers[1].selectedOptionIds.length === 2, "Multiple selections lost");
      pass("Questions return the selected answers and reject incomplete submissions");
      for (const outcome of ["accepted", "rejected"] as const) {
        requestId = await ask(id, "cursor/create_plan", plan);
        answerCursorRequest(id, pendingRequest(chat(id))!.id, { outcome });
        await until(() => reply(requestId));
        assert(reply(requestId)!.result.outcome.outcome === outcome, "Plan outcome mismatch");
      }
      pass("Plan acceptance and rejection unblock the adapter");
      const notification = { toolCallId: "todo", todos: [{ id: "1", content: "Inspect", status: "pending" }], merge: false };
      requestId = cursorRequest(id, "cursor/update_todos", notification);
      await until(() => reply(requestId));
      cursorNotification(id, "cursor/update_todos", { ...notification, todos: [{ id: "1", content: "Inspect", status: "completed" }], merge: true });
      await until(() => chat(id).turns.at(-1)?.items.some(item => item.kind === "plan" && item.entries[0]?.status === "completed"));
      pass("Todo notifications work as both notifications and RPC requests");
      requestId = cursorRequest(id, "cursor/create_plan", { ...plan, plan: null });
      await until(() => reply(requestId));
      assert(reply(requestId)?.error?.code === -32602, "Invalid plan did not receive a protocol error");
      pass("Malformed requests fail promptly without blocking the conversation");
      requestId = await ask(id, "cursor/ask_question", question);
      cancelTurn(id);
      await until(() => reply(requestId) && chat(id).status === "ready");
      assert(reply(requestId)!.result.outcome.outcome === "cancelled" && !pendingRequest(chat(id)), "Stop left a pending interaction");
      const late = cursorRequest(id, "cursor/create_plan", plan);
      await until(() => reply(late));
      assert(reply(late)!.result.outcome.outcome === "cancelled", "Late request reopened cancelled turn");
      pass("Stop dismisses pending requests and cancels late arrivals");
      await closeChat(id);
      id = await open(true);
      sendPrompt(id, "wait");
      requestId = cursorRequest(id, "session/request_permission", permission);
      await until(() => reply(requestId));
      assert(reply(requestId)!.result.outcome.optionId === "allow-once", "Full access did not approve tool once");
      requestId = await ask(id, "cursor/create_plan", plan);
      assert(!reply(requestId), "Full access silently accepted a plan");
      answerCursorRequest(id, pendingRequest(chat(id))!.id, { outcome: "rejected" });
      await until(() => reply(requestId));
      requestId = await ask(id, "cursor/ask_question", question);
      assert(!reply(requestId), "Full access silently answered a question");
      answerCursorRequest(id, pendingRequest(chat(id))!.id, { outcome: "skipped" });
      await until(() => reply(requestId));
      pass("Full access approves tools once but still asks for decisions");
      await ask(id, "cursor/create_plan", plan);
      finishCursor(id, "max_turn_requests");
      await until(() => chat(id).status === "ready" && !pendingRequest(chat(id)));
      pass("Turn completion clears an unanswered request");
      sendPrompt(id, "wait");
      await ask(id, "cursor/ask_question", question);
      await closeChat(id);
      assert(!chat(id) && cursorMock.killed.includes(id), "Close retained the agent or conversation");
      pass("Closing a pending interaction stops the adapter and removes its state");
      useChatModelStore.getState().remember("cursor", { id: "auto[]", name: "Auto" });
      id = await open(false, true);
      assert(calls(id).slice(0, 3).map(call => call.method).join(",") === "initialize,authenticate,session/load", "Resume skipped authentication");
      assert(chat(id).options.find(option => option.id === "model")?.value === "sonnet[thinking=true]" && chat(id).turns[0].endedAt !== null, "Resume lost model or replayed history");
      await closeChat(id);
      pass("Resume authenticates first and keeps the saved model and history");
      cursorMock.authFailure = true;
      id = await open();
      assert(chat(id).error?.includes("cursor-agent login") && !calls(id).some(call => call.method === "session/new"), "Auth failure did not explain login or still started a session");
      pass("Authentication failure gives a useful recovery command");
      setStatus("All 13 checks passed");
    } catch (error) { setStatus(`FAIL: ${error instanceof Error ? error.message : error}`); }
    finally {
      for (const id of Object.keys(useChatStore.getState().chats)) await closeChat(Number(id));
      useChatModelStore.setState({ models: savedModels });
      if (savedStorage === null) localStorage.removeItem("shep:chat-models"); else localStorage.setItem("shep:chat-models", savedStorage);
      cursorMock.authFailure = false;
    }
  };
  return <main><h1>Cursor ACP regression checks</h1><p>Real Shep session code with a simulated Cursor CLI.</p><button onClick={() => void run()} disabled={status === "Running"}>Run checks</button><p role="status">{status}</p><ul>{results.map(row => <li key={row}>{row}</li>)}</ul></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
