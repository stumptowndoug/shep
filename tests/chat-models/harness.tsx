import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { startChat, closeChat, setChatOption } from "../../src/lib/acp/chatSessions";
import { isModelOption } from "../../src/lib/acp/chatOptions";
import { CODING_ASSISTANTS } from "../../src/components/sidebar/constants";
import { useChatStore } from "../../src/stores/useChatStore";
import { useChatModelStore } from "../../src/stores/useChatModelStore";
import { useTerminalStore } from "../../src/stores/useTerminalStore";
import type { AcpOutput } from "../../src/lib/tauri";

const choices = [{ value: "base", name: "Provider default" }, { value: "preferred", name: "Vendor / Preferred" }, { value: "restored", name: "Conversation model" }];
const channels = new Map<number, Channel<AcpOutput>>();
const models = new Map<number, string>();
let nextId = 100;
let legacy = false;
let rejectModel = false;
let clampModel = false;
let holdModel = false;
let releaseModel: (() => void) | undefined;
let modelWrites: { chatId: number; method: string; value: string }[] = [];

const config = (chatId: number) => [
  { id: "provider_model", name: "Model", category: "model", type: "select", currentValue: models.get(chatId), options: choices },
  { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
];

// Real ACP client/session code; every native operation is simulated.
mockIPC((cmd, payload) => {
  const args = payload as Record<string, unknown>;
  if (cmd === "spawn_acp_agent") {
    const id = ++nextId;
    channels.set(id, args.onOutput as Channel<AcpOutput>);
    models.set(id, "base");
    return id;
  }
  if (cmd !== "write_acp_agent") return null;
  const chatId = Number(args.agentId);
  const message = JSON.parse(String(args.line));
  const emit = (data: object) => queueMicrotask(() => channels.get(chatId)?.onmessage({ event: "line", data: JSON.stringify({ jsonrpc: "2.0", id: message.id, ...data }) }));
  if (message.method === "initialize") emit({ result: { agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new" || message.method === "session/load") {
    if (message.method === "session/load") models.set(chatId, "restored");
    emit({ result: { sessionId: `session-${chatId}`, ...(legacy
      ? { models: { currentModelId: models.get(chatId), availableModels: choices.map((choice) => ({ modelId: choice.value, name: choice.name })) } }
      : { configOptions: config(chatId) }) } });
  } else if (message.method === "session/set_model" || message.method === "session/set_config_option") {
    const value = message.params.modelId ?? message.params.value;
    const isModel = message.method === "session/set_model" || message.params.configId === "provider_model";
    if (isModel) modelWrites.push({ chatId, method: message.method, value });
    const reply = () => {
      if (isModel && rejectModel) emit({ error: { code: -32602, message: "Model unavailable" } });
      else {
        if (isModel && !clampModel) models.set(chatId, value);
        emit({ result: legacy ? {} : { configOptions: config(chatId) } });
      }
    };
    if (isModel && holdModel) releaseModel = reply;
    else reply();
  }
  return null;
}, { shouldMockEvents: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for mocked chat");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
const currentModel = (id: number) => useChatStore.getState().chats[id]?.options.find(isModelOption);
async function open(assistantId = "pi", resume = false, repoPath = "/test/project") {
  useTerminalStore.getState().switchProject(repoPath);
  const id = await startChat({ assistant: CODING_ASSISTANTS.find((assistant) => assistant.id === assistantId)!, repoPath, mode: "standard",
    ...(resume ? { resume: { sessionId: "previous", title: "Saved chat", startedAt: 1 } } : {}) });
  await until(() => useChatStore.getState().chats[id]?.status === "ready");
  return id;
}
async function reset() {
  for (const id of Object.keys(useChatStore.getState().chats)) await closeChat(Number(id));
  legacy = rejectModel = clampModel = holdModel = false;
  releaseModel = undefined;
  modelWrites = [];
  useChatModelStore.setState({ models: {} });
}
const remember = (agent = "pi", id = "preferred") => useChatModelStore.getState().remember(agent, { id, name: id });

function Harness() {
  const [status, setStatus] = useState("Ready");
  const [results, setResults] = useState<string[]>([]);
  const run = async () => {
    setStatus("Running");
    setResults([]);
    const originalModels = useChatModelStore.getState().models;
    const originalStorage = localStorage.getItem("shep:chat-models");
    const pass = (name: string) => setResults((rows) => [...rows, `PASS: ${name}`]);
    try {
      await reset();
      let id = await open();
      assert(currentModel(id)?.value === "base" && modelWrites.length === 0, "First chat did not use provider default");
      await setChatOption(id, "effort", "low");
      assert(!useChatModelStore.getState().models.pi, "Opening a chat or changing reasoning saved a model");
      await setChatOption(id, "provider_model", "preferred");
      assert(useChatModelStore.getState().models.pi?.id === "preferred", "Accepted model was not remembered");
      const next = await open("pi", false, "/test/other-project");
      assert(currentModel(next)?.value === "preferred", "Choice was not reused across projects");
      assert(currentModel(await open("opencode"))?.value === "base", "Preference leaked between agents");
      pass("First-use default, successful selection, cross-project reuse, and agent isolation");

      await reset();
      remember();
      id = await open("pi", true);
      assert(currentModel(id)?.value === "restored" && modelWrites.length === 0, "Saved preference overwrote a resumed conversation");
      assert(useChatModelStore.getState().models.pi?.id === "preferred", "Resume overwrote the preference");
      pass("Resumed conversations preserve their model without changing new-chat preferences");

      await reset();
      remember("pi", "removed-model");
      id = await open();
      assert(currentModel(id)?.value === "base" && modelWrites.length === 0, "Unavailable preference did not fall back to agent default");
      pass("Unavailable models fall back without sending invalid choices");

      await reset();
      remember();
      rejectModel = true;
      id = await open();
      assert(currentModel(id)?.value === "base", "Rejected startup choice left the chat on the wrong model");
      await setChatOption(id, "provider_model", "restored");
      assert(currentModel(id)?.value === "base" && useChatModelStore.getState().models.pi?.id === "preferred", "Failed selection overwrote the saved choice");
      pass("Rejected model changes leave startup usable and preserve the saved choice");

      await reset();
      id = await open();
      remember("pi", "restored");
      clampModel = true;
      await setChatOption(id, "provider_model", "preferred");
      assert(currentModel(id)?.value === "base" && useChatModelStore.getState().models.pi?.id === "restored", "Clamped model was remembered as selected");
      pass("Agent-clamped choices are not saved as successful selections");

      await reset();
      legacy = true;
      id = await open();
      await setChatOption(id, "model", "preferred");
      const legacyNext = await open();
      assert(currentModel(legacyNext)?.value === "preferred" && modelWrites.every((write) => write.method === "session/set_model"), "Legacy model protocol was not restored correctly");
      pass("Legacy model selection and modern category-based settings both work");

      useChatModelStore.getState().useAgentDefault("pi");
      assert(currentModel(legacyNext)?.value === "preferred", "Reset changed an open conversation");
      assert(currentModel(await open())?.value === "base", "Reset did not restore provider defaults for new chats");
      pass("Use agent default applies to future chats and leaves open chats untouched");

      await reset();
      id = await open();
      holdModel = true;
      const changing = setChatOption(id, "provider_model", "preferred");
      await until(() => Boolean(releaseModel));
      await closeChat(id);
      releaseModel!();
      await changing;
      assert(!useChatModelStore.getState().models.pi, "Closed chat saved a pending selection");
      pass("Closing a chat with a pending model change cannot save a late result");
      setStatus("All 8 checks passed");
    } catch (error) {
      setStatus(`FAIL: ${error instanceof Error ? error.message : error}`);
    } finally {
      await reset();
      useChatModelStore.setState({ models: originalModels });
      if (originalStorage === null) localStorage.removeItem("shep:chat-models");
      else localStorage.setItem("shep:chat-models", originalStorage);
    }
  };
  return <main><h1>Chat model preference checks</h1><p>Real session code with simulated agents; no paid requests or agent settings are changed.</p><button disabled={status === "Running"} onClick={() => void run()}>Run checks</button><p role="status">{status}</p><ul>{results.map((result) => <li key={result}>{result}</li>)}</ul></main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
