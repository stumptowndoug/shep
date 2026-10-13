import assert from "node:assert/strict";
import test from "node:test";
import { mentionAt, promptBlocks, rankFiles } from "../src/lib/acp/fileMentions.ts";

test("a mention is the @word being typed at the caret, not an email or a finished word", () => {
  assert.deepEqual(mentionAt("look at @src/Ch", 15), { start: 8, query: "src/Ch" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail me@example.com", 19), null);
  assert.equal(mentionAt("@src/a.ts done", 14), null);
  assert.deepEqual(mentionAt("@src/a.ts done", 4), { start: 0, query: "src" });
});

test("file ranking prefers name matches, then paths, then loose subsequences", () => {
  const files = ["src/components/chat/ChatView.tsx", "src/components/chat/ChatComposer.tsx", "docs/chat-view.md", "README.md", "src/lib/acp/chatModel.ts"];
  assert.deepEqual(rankFiles(files, "chatview"), ["src/components/chat/ChatView.tsx", "docs/chat-view.md"]);
  assert.equal(rankFiles(files, "composer")[0], "src/components/chat/ChatComposer.tsx");
  assert.equal(rankFiles(files, "chtv")[0], "src/components/chat/ChatView.tsx");
  assert.deepEqual(rankFiles(files, "zzz"), []);
  assert.deepEqual(rankFiles(files, ""), ["README.md"]);
});

test("mentions of known files become resource links in place; other @words stay text", () => {
  const files = new Set(["src/a b.ts", "README.md"]);
  assert.deepEqual(promptBlocks("fix @src/a b.ts", files, "/repo"), [{ type: "text", text: "fix @src/a b.ts" }]);
  assert.deepEqual(promptBlocks("compare @README.md, then ping @dave", new Set(["README.md"]), "/repo/"), [
    { type: "text", text: "compare " },
    { type: "resource_link", uri: "file:///repo/README.md", name: "README.md" },
    { type: "text", text: ", then ping @dave" },
  ]);
  assert.deepEqual(promptBlocks("@README.md", files, "/my repo"), [
    { type: "resource_link", uri: "file:///my%20repo/README.md", name: "README.md" },
  ]);
  assert.deepEqual(promptBlocks("no mentions", files, "/repo"), [{ type: "text", text: "no mentions" }]);
});
