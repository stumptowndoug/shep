import assert from "node:assert/strict";
import test from "node:test";
import { agentMedia, MAX_IMAGE_DATA, MAX_TOOL_TEXT, rawText } from "../src/lib/acp/chatContent.ts";
import { addNotice, applySessionUpdate, emptyChat, endTurn, startTurn } from "../src/lib/acp/chatModel.ts";
import { errorTone, projectRelativePath, splitTurn, turnChanges, turnStopMessage } from "../src/lib/acp/chatPresentation.ts";

const turn = () => startTurn(emptyChat(), "Review this change");
const message = (text: string, messageId?: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });

test("Claude metadata and raw targets describe command, search and fetch calls", () => {
  let chat = turn();
  for (const [id, name, rawInput, expectedKind, title] of [
    ["1", "Bash", { command: ["pnpm", "test"] }, "execute", "pnpm test"],
    ["2", "Grep", { pattern: "useChat", path: "src" }, "search", "useChat in src"],
    ["3", "WebFetch", { url: "https://example.com/docs" }, "fetch", "https://example.com/docs"],
  ] as const) {
    chat = applySessionUpdate(chat, { sessionUpdate: "tool_call", toolCallId: id, kind: "other", title: name, rawInput, _meta: { claudeCode: { toolName: name } } });
    const tool = chat.turns[0].items.at(-1)!;
    assert.equal(tool.kind, "tool");
    if (tool.kind !== "tool") continue;
    assert.equal(tool.toolKind, expectedKind);
    assert.equal(tool.title, title);
  }
  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call_update", toolCallId: "1", title: "Bash", status: "failed", rawOutput: { stdout: "Tests started", stderr: "Missing fixture" } });
  const tool = chat.turns[0].items[0];
  assert.equal(tool.kind === "tool" && tool.title, "pnpm test");
  assert.equal(tool.kind === "tool" && tool.output, "Tests started\nMissing fixture");
});

test("multi-megabyte tool output stays bounded and keeps the useful tail", () => {
  const huge = "x".repeat(3 * 1024 * 1024) + "\nThe final error";
  for (const payload of [
    { rawOutput: { stdout: huge } },
    { rawOutput: { formatted_output: huge } },
    { content: [{ type: "content", content: { type: "text", text: huge } }] },
  ]) {
    const chat = applySessionUpdate(turn(), { sessionUpdate: "tool_call", toolCallId: "1", ...payload });
    const tool = chat.turns[0].items[0];
    assert.equal(tool.kind, "tool");
    if (tool.kind !== "tool") continue;
    assert.ok(tool.output.length <= MAX_TOOL_TEXT);
    assert.match(tool.output, /truncated/);
    assert.ok(tool.output.endsWith("The final error"));
  }
  const cyclic: Record<string, unknown> = { huge };
  cyclic.self = cyclic;
  assert.ok(rawText(cyclic).length <= MAX_TOOL_TEXT);
  assert.ok(rawText({ ["x".repeat(500)]: 1, ["x".repeat(501)]: 2 }).length <= MAX_TOOL_TEXT);
});

test("large and excessive diffs are explicitly omitted, not rendered as fake changes", () => {
  const chat = applySessionUpdate(turn(), { sessionUpdate: "tool_call", toolCallId: "edit", content: [
    { type: "diff", path: "large.txt", oldText: "before", newText: "x".repeat(2_000_000) },
    { type: "diff", path: "many-lines.txt", oldText: "", newText: "x\n".repeat(3000) },
    ...Array.from({ length: 12 }, (_, i) => ({ type: "diff", path: `file-${i}`, oldText: "old", newText: "new" })),
  ] });
  const tool = chat.turns[0].items[0];
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") return;
  assert.equal(tool.diffs.length, 8);
  assert.equal(tool.omittedDiffs, 6);
  assert.deepEqual(tool.diffs[0], { path: "large.txt", oldText: null, newText: "", truncated: true });
  assert.equal(tool.diffs[1].truncated, true);
  assert.equal(tool.diffs[2].newText, "new");
});

test("agent media accepts only bounded image data and http(s) resource links", () => {
  assert.ok(agentMedia({ type: "image", mimeType: "image/png", data: "YWJj" }));
  assert.ok(agentMedia({ type: "resource_link", uri: "https://example.com/result", name: "Report" }));
  for (const content of [
    { type: "image", mimeType: "text/html", data: "YWJj" },
    { type: "image", mimeType: "image/png", data: "not base64" },
    { type: "image", mimeType: "image/png", data: "x".repeat(MAX_IMAGE_DATA + 4) },
    ...["javascript:alert(1)", "data:text/html,Hi", "file:///tmp/secret", "not a url"].map(uri => ({ type: "resource_link", uri })),
  ]) assert.equal(agentMedia(content), null);
  let chat = applySessionUpdate(turn(), { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "YWJj" } });
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com" } });
  assert.deepEqual(chat.turns[0].items.map(item => item.kind), ["media", "media"]);
});

test("all answer blocks remain visible after the last tool, even with a trailing notice", () => {
  let chat = applySessionUpdate(turn(), message("I'll inspect the code.", "narration"));
  chat = applySessionUpdate(chat, { sessionUpdate: "tool_call", toolCallId: "1", title: "Read file" });
  chat = applySessionUpdate(chat, message("First finding.", "a"));
  chat = applySessionUpdate(chat, message("Second finding.", "b"));
  chat = applySessionUpdate(chat, { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.com" } });
  chat = addNotice(chat, "A helpful notice");
  assert.equal(splitTurn(chat.turns[0]).work.length, 0);
  const { work, answer } = splitTurn(endTurn(chat, "end_turn").turns[0]);
  assert.deepEqual(work.map(item => item.kind), ["message", "tool"]);
  assert.deepEqual(answer.map(item => item.kind), ["message", "message", "media", "notice"]);
});

test("stops explain cancellation, response limits, turn limits and errors", () => {
  for (const reason of ["max_tokens", "max_turn_requests"]) {
    assert.match(turnStopMessage(endTurn(turn(), reason).turns[0])!, /continue/);
  }
  assert.equal(turnStopMessage(endTurn(turn(), "cancelled").turns[0]), "Stopped.");
  assert.equal(turnStopMessage(endTurn(turn(), "error", "Provider unavailable").turns[0]), "Provider unavailable");
  assert.equal(turnStopMessage(endTurn(turn(), "end_turn").turns[0]), null);
});

test("unidentified chunks preserve streamed code instead of guessing paragraph boundaries", () => {
  let chat = applySessionUpdate(turn(), message("const value = object."));
  chat = applySessionUpdate(chat, message("Next;"));
  assert.equal(chat.turns[0].items[0].kind === "message" && chat.turns[0].items[0].text, "const value = object.Next;");
});

test("text diffs in tool output are recognized and split into colored lines", async () => {
  const { textDiffLines } = await import("../src/lib/acp/chatPresentation.ts");
  const muse = [
    "edit_file: src/consts.ts", "changed lines: line 1",
    "--- original", "+++ updated", "@@", "-export const RELEASE_VERSION = '0.9.2';", "+export const RELEASE_VERSION = '0.10.1';",
  ].join("\n");
  assert.deepEqual(textDiffLines(muse)?.map((line) => line.kind), ["context", "context", "header", "header", "hunk", "remove", "add"]);
  // Ordinary output that merely has dashes or pluses stays plain.
  assert.equal(textDiffLines("- item one\n+ item two\nTotal: 2"), null);
  assert.equal(textDiffLines("--- original\n+++ updated\nno changes"), null);
});

test("limits read as warnings; other turn and session failures as errors", () => {
  for (const text of ["Rate limit reached for claude-opus", "429 Too Many Requests", "You've hit your usage limit", "API Error: Overloaded"]) {
    assert.equal(errorTone(text), "warning", text);
  }
  for (const text of ["Claude Code exited (code 1).", "Request failed", "Couldn’t start Codex: spawn ENOENT"]) {
    assert.equal(errorTone(text), "error", text);
  }
});

test("a turn's changes group its diffs by file in first-touched order and skip failed edits", () => {
  const tool = (id: string, status: string, diffs: { path: string; oldText: string | null; newText: string }[]) =>
    ({ kind: "tool" as const, id, toolCallId: id, title: id, toolKind: "edit", status: status as "completed", output: "", diffs });
  const turn = {
    id: 0, prompt: "fix", startedAt: 0, endedAt: 1, stopReason: "end_turn",
    items: [
      tool("a", "completed", [{ path: "/repo/src/b.ts", oldText: "x\ny", newText: "x\nz" }]),
      tool("b", "completed", [{ path: "/repo/README.md", oldText: null, newText: "# Hi\nnew" }]),
      tool("c", "failed", [{ path: "/repo/src/c.ts", oldText: "a", newText: "b" }]),
      tool("d", "completed", [{ path: "/repo/src/b.ts", oldText: "z", newText: "z\nw" }]),
    ],
  };
  assert.deepEqual(turnChanges(turn).map(({ path, diffs, added, removed }) => [path, diffs.length, added, removed]), [
    ["/repo/src/b.ts", 2, 2, 1],
    ["/repo/README.md", 1, 2, 0],
  ]);
  assert.equal(projectRelativePath("/repo/src/b.ts", "/repo/"), "src/b.ts");
  assert.equal(projectRelativePath("/elsewhere/x.ts", "/repo"), "/elsewhere/x.ts");
  assert.equal(projectRelativePath("/repository/x.ts", "/repo"), "/repository/x.ts");
});
