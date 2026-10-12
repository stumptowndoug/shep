import test from "node:test";
import assert from "node:assert/strict";
import { chatAppearanceStyle, CHAT_FONT_SIZE, DEFAULT_CHAT_APPEARANCE, parseChatAppearance } from "../src/lib/chatAppearance.ts";

test("saved chat appearance falls back to defaults when missing or invalid", () => {
  assert.deepEqual(parseChatAppearance(null), DEFAULT_CHAT_APPEARANCE);
  assert.deepEqual(parseChatAppearance("{oops"), DEFAULT_CHAT_APPEARANCE);
  assert.deepEqual(parseChatAppearance('{"fontFamily":"  ","fontSize":99,"loadFont":true}'), DEFAULT_CHAT_APPEARANCE);
  assert.deepEqual(parseChatAppearance('{"fontFamily":"Inter","fontSize":18,"loadFont":true}'), { fontFamily: "Inter", loadFont: true, fontSize: 18 });
});

test("chat style scales from the default size and quotes the font", () => {
  const plain = chatAppearanceStyle(DEFAULT_CHAT_APPEARANCE, '"MesloLGS NF", monospace');
  assert.deepEqual(plain, { "--chat-scale": "1", "--chat-code-font": '"MesloLGS NF", monospace' });

  const custom = chatAppearanceStyle({ fontFamily: 'My "Font"', loadFont: false, fontSize: 18 }, "monospace");
  assert.equal(custom["--chat-scale"], String(18 / CHAT_FONT_SIZE));
  assert.equal(custom["--chat-font"], '"My \\"Font\\"", ui-sans-serif, -apple-system, sans-serif');
});
