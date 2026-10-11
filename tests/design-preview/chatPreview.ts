// ACP simulator for exercising the real composer/session code without launching an agent.
import type { Channel } from "@tauri-apps/api/core";
import type { AcpOutput } from "../../src/lib/tauri";
import { mockCursorCommand } from "../cursor-chat/mockCursor";
import { mockAntigravityCommand } from "../antigravity-chat/mockAntigravity";

const channels = new Map<number, Channel<AcpOutput>>();
const prompts = new Map<number, number>();
const permissions = new Map<string, number>();
const noticesEnabled = new Map<number, boolean>();
const piStartupInfo = "pi v1.1.0\n---\n\n## Extensions\n- npm:pi-web-access\n  - index.ts\n- npm:@tintinweb/pi-subagents\n  - index.ts\n";
let nextId = 2000;
const options = (longLabels = false) => [
  {id:"model",name:"Model",category:"model",type:"select",currentValue:"sonnet",options:longLabels ? [
    {value:"sonnet",name:"anthropic / Claude Sonnet 4.5"},
    {value:"opus",name:"openrouter / anthropic/claude-opus-4.6"},
    {value:"gemini",name:"google-vertex / Gemini 2.5 Pro Preview 06-05"},
    {value:"bedrock",name:"amazon-bedrock / us.anthropic.claude-sonnet-4-20250514-v1:0"},
  ] : [{value:"sonnet",name:"Sonnet"},{value:"opus",name:"Opus"}]},
  {id:"effort",name:"Effort",category:"thought_level",description:"How much reasoning the model uses.",type:"select",currentValue:"high",options:[{value:"low",name:"Low"},{value:"high",name:"High",description:longLabels ? "Spend more time reasoning through complex problems before responding, with a larger budget for difficult coding tasks." : undefined}]},
  {id:"fast",name:"Fast mode",category:"model_config",description:"Faster responses on supported models.",type:"select",currentValue:"off",options:[{value:"on",name:"On"},{value:"off",name:"Off"}]},
  {id:"mode",name:"Mode",category:"mode",type:"select",currentValue:"default",options:[{value:"default",name:"Manual"},{value:"acceptEdits",name:"Accept edits",description:"Automatically accept file edits."},{value:"plan",name:"Plan",description:"Plan before making changes."},{value:"bypassPermissions",name:"Bypass permissions"}]},
];
const configs = new Map<number, ReturnType<typeof options>>();
const emit = (chatId: number, message: object) => queueMicrotask(() => channels.get(chatId)?.onmessage({event:"line",data:JSON.stringify({jsonrpc:"2.0",...message})}));
const complete = (chatId: number, stopReason = "end_turn") => {
  const id = prompts.get(chatId);
  if (id === undefined) return;
  prompts.delete(chatId);
  if (stopReason !== "cancelled") emit(chatId, {method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Preview complete. No commands were run."}}}});
  emit(chatId, {id,result:{stopReason}});
};

export function mockChatCommand(cmd: string, args: Record<string, unknown>, scenario: string | null) {
  if (scenario === "cursor") return mockCursorCommand(cmd, args);
  if (scenario === "antigravity") return mockAntigravityCommand(cmd, args);
  if (cmd === "spawn_acp_agent") {
    const id = ++nextId;
    channels.set(id, args.onOutput as Channel<AcpOutput>);
    const config = options(scenario === "labels");
    if (scenario?.startsWith("pi")) {
      const thinking = config[1];
      thinking.id = "thought_level";
      thinking.name = "Thinking";
      thinking.options.forEach((choice) => { choice.name = `Thinking: ${choice.value}`; });
      config.splice(2);
    }
    configs.set(id, config);
    return id;
  }
  if (cmd === "kill_acp_agent") {
    document.documentElement.dataset.previewClosedChat = String(args.agentId);
    return null;
  }
  if (cmd !== "write_acp_agent") return null;
  const chatId = Number(args.agentId);
  const message = JSON.parse(String(args.line));
  const config = configs.get(chatId)!;
  const reply = (result: object) => emit(chatId, {id:message.id,result});
  if (message.method === "initialize") {
    noticesEnabled.set(chatId, Boolean(message.params.clientCapabilities?.session?.notices));
    reply({agentCapabilities:{loadSession:true}});
  }
  else if (message.method === "session/new" || message.method === "session/load") {
    if (scenario?.startsWith("pi")) {
      const thinking = config[1];
      reply({sessionId:`preview-chat-${chatId}`,configOptions:config,
        modes:{currentModeId:thinking.currentValue,availableModes:thinking.options.map((choice) => ({id:choice.value,name:choice.name}))},
        _meta:{piAcp:{startupInfo:piStartupInfo}}});
      const banner = () => emit(chatId, {method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:piStartupInfo}}}});
      if (scenario === "pi-late") setTimeout(banner, 0);
      else banner();
    } else reply({sessionId:`preview-chat-${chatId}`,configOptions:config});
    emit(chatId, {method:"session/update",params:{update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"compact",description:"Summarize this conversation"}]}}});
  } else if (message.method === "session/set_config_option") {
    document.documentElement.dataset.previewChatOption = JSON.stringify(message.params);
    if (scenario === "error" && message.params.configId === "mode" && message.params.value === "default") {
      emit(chatId, {id:message.id,error:{code:-32000,message:"Preview: permission change rejected"}});
    } else {
      const option = config.find(item => item.id === message.params.configId)!;
      option.currentValue = scenario === "clamp" && option.id === "fast" ? "off" : message.params.value;
      reply({configOptions:config});
    }
  } else if (message.method === "session/prompt") {
    prompts.set(chatId, message.id);
    const text = message.params.prompt.map((item: {text?: string}) => item.text ?? "").join(" ");
    if (text.includes("wait")) return null;
    if (scenario === "features") {
      const update = (value: object) => emit(chatId, {method:"session/update",params:{update:value}});
      update({sessionUpdate:"agent_message_chunk",messageId:"narration",content:{type:"text",text:"I'll check the chat renderer and its tests."}});
      update({sessionUpdate:"tool_call",toolCallId:"search",kind:"search",title:"Grep",rawInput:{pattern:"ChatItemView",path:"src/components/chat"},status:"completed"});
      update({sessionUpdate:"tool_call",toolCallId:"test",kind:"other",title:"Bash",_meta:{claudeCode:{toolName:"Bash"}},rawInput:{command:"pnpm test:chat"},status:"in_progress"});
      update({sessionUpdate:"tool_call_update",toolCallId:"test",status:"failed",rawOutput:{stdout:Array.from({length:28},(_,i)=>`PASS  chat renderer check ${String(i+1).padStart(2,"0")}`).join("\n"),stderr:"FAIL  expected image output to be visible\n      Missing image fixture: chat-preview.png"}});
      update({sessionUpdate:"agent_message_chunk",messageId:"answer-a",content:{type:"text",text:"The chat renderer is working. One test needs its missing image fixture."}});
      update({sessionUpdate:"agent_message_chunk",messageId:"answer-b",content:{type:"text",text:"Text, images and resource links stay together in the final answer."}});
      const diagram = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="92" viewBox="0 0 520 92"><rect width="520" height="92" rx="12" fill="#e8efe9"/><g fill="#243b31" font-family="sans-serif" font-size="14" text-anchor="middle"><rect x="18" y="22" width="132" height="48" rx="8" fill="#fff"/><text x="84" y="51">Agent output</text><path d="M165 46h28m-7-5 7 5-7 5" fill="none" stroke="#587a66" stroke-width="2"/><rect x="205" y="22" width="120" height="48" rx="8" fill="#fff"/><text x="265" y="51">Safe content</text><path d="M340 46h28m-7-5 7 5-7 5" fill="none" stroke="#587a66" stroke-width="2"/><rect x="380" y="22" width="122" height="48" rx="8" fill="#fff"/><text x="441" y="51">Chat view</text></g></svg>';
      update({sessionUpdate:"agent_message_chunk",content:{type:"image",mimeType:"image/svg+xml",data:btoa(diagram)}});
      update({sessionUpdate:"agent_message_chunk",content:{type:"resource_link",uri:"https://example.com/chat-checks",name:"Chat renderer check report"}});
      prompts.delete(chatId);
      reply({stopReason:"max_tokens"});
      return null;
    }
    if (scenario === "fast-unavailable" && config.find((option) => option.id === "fast")?.currentValue === "on") {
      const fast = config.find((option) => option.id === "fast")!;
      fast.currentValue = "off";
      const update = noticesEnabled.get(chatId)
        ? { sessionUpdate: "notice", severity: "warning", title: "Fast mode turned off", description: "Requires extra usage to be enabled for this account." }
        : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Fast mode turned off:** requires extra usage to be enabled for this account." } };
      emit(chatId, {method:"session/update",params:{update}});
      emit(chatId, {method:"session/update",params:{update:{sessionUpdate:"config_option_update",configOptions:config}}});
      for (const text of ["It’s because of Rayleigh scattering.", " Air molecules scatter short (blue) wavelengths of sunlight much more than long (red) ones."]) {
        emit(chatId, {method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}});
      }
      prompts.delete(chatId);
      reply({stopReason:"end_turn"});
      return null;
    }
    const requestId = `preview-permission-${chatId}-${message.id}`;
    permissions.set(requestId, chatId);
    emit(chatId, {id:requestId,method:"session/request_permission",params:{toolCall:{title:"Run the preview check"},options:[{optionId:"allow",name:"Allow once",kind:"allow_once"},{optionId:"deny",name:"Deny",kind:"reject_once"}]}});
  } else if (message.method === "session/cancel") {
    complete(chatId, "cancelled");
  } else if (message.id && permissions.has(message.id)) {
    permissions.delete(message.id);
    document.documentElement.dataset.previewPermissionOutcome = JSON.stringify(message.result);
    complete(chatId);
  }
  return null;
}
