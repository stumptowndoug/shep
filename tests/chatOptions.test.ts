import assert from "node:assert/strict";
import { test } from "node:test";
import { accessChoice, chatOptionName, isAccessOption, isReasoningOption } from "../src/lib/acp/chatOptions.ts";
import type { ChatOption } from "../src/lib/acp/chatModel.ts";

test("access labels preserve provider wire values and meaningful non-access modes", () => {
  assert.equal(accessChoice({value:"bypassPermissions",name:"Bypass permissions"}).label, "Full access");
  assert.equal(accessChoice({value:"default",name:"Manual"}).label, "Ask first");
  assert.deepEqual(accessChoice({value:"plan",name:"Plan",description:"Plan first"}), {value:"plan",label:"Plan",description:"Plan first"});
});

test("recognizes provider permission controls without treating every mode or On/Off setting as access", () => {
  const mode: ChatOption = {id:"mode",name:"Mode",source:"config",value:"default",choices:[{value:"default",name:"Manual"},{value:"bypassPermissions",name:"Bypass"}]};
  assert.equal(isAccessOption(mode), true);
  assert.equal(isAccessOption({...mode,id:"fast",name:"Fast mode",choices:[{value:"on",name:"On"},{value:"off",name:"Off"}]}), false);
  assert.equal(isAccessOption({...mode,choices:[{value:"build",name:"Build"},{value:"plan",name:"Plan"}]}), false);
});

test("recognizes reasoning metadata and common provider IDs without exposing unrelated settings", () => {
  const option: ChatOption = { id: "effort", name: "Effort", source: "config", value: "high", choices: [{ value: "high", name: "High" }] };
  assert.equal(isReasoningOption(option), true);
  assert.equal(chatOptionName(option), "Reasoning");
  assert.equal(isReasoningOption({ ...option, id: "custom_effort", category: "thought_level" }), true);
  assert.equal(isReasoningOption({ ...option, id: "reasoning_effort" }), true);
  assert.equal(isReasoningOption({ ...option, id: "fast", name: "Fast mode", category: "model_config" }), false);
});
