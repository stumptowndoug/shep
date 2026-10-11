import type { ChatOption } from "./chatModel";

const FULL_ACCESS_MODES = new Set(["bypasspermissions", "full-access", "agent-full-access", "agent-full", "yolo", "full"]);
const ASK_MODES = new Set(["default", "manual", "ask", "ask-first"]);

export const isFullAccessMode = (value: string) => FULL_ACCESS_MODES.has(value.toLowerCase());

/** Only permission modes get access wording; an agent's Build/Plan modes stay separate. */
export function isAccessOption(option: ChatOption) {
  return (option.source === "mode" || option.category === "mode" || /^(mode|permissions?|access)$/i.test(option.id)) &&
    option.choices.some((choice) => isFullAccessMode(choice.value));
}

export function accessChoice(choice: ChatOption["choices"][number]) {
  if (isFullAccessMode(choice.value)) return {
    value: choice.value, label: "Full access", description: "Edits and runs commands without asking.",
  };
  if (ASK_MODES.has(choice.value.toLowerCase())) return {
    value: choice.value, label: "Ask first", description: "Review the agent’s permission requests before it proceeds.",
  };
  return { value: choice.value, label: choice.name, description: choice.description };
}

export const isModelOption = (option: ChatOption) =>
  option.source === "model" || option.category === "model" || option.id === "model";

export const isReasoningOption = (option: ChatOption) =>
  option.category === "thought_level" || /^(effort|reasoning_effort|reasoning)$/i.test(option.id);

export const chatOptionName = (option: ChatOption) =>
  isAccessOption(option) ? "Access" : isReasoningOption(option) ? "Reasoning" : option.name;

export const chatOptionChoices = (option: ChatOption) => option.choices.map((choice) => {
  let label = isAccessOption(option) ? accessChoice(choice).label : choice.name;
  if (isReasoningOption(option)) {
    label = label.replace(/^(?:thinking|reasoning)(?:\s+(?:level|effort))?\s*:\s*/i, "");
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }
  return { value: choice.value, label };
});
