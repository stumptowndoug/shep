import test from "node:test";
import assert from "node:assert/strict";
import markdownit from "markdown-it";
import { renderBlocks } from "../src/lib/markdownBlocks.ts";

const markdown = markdownit({ linkify: true, typographer: true });

test("blocks render to the same HTML as the whole reply, references and all", () => {
  const text = [
    "# Plan", "", "See [the docs][docs] first.", "",
    "- one", "- two", "  continued", "", "> quoted", "",
    "```ts", "const a = 1;", "```", "", "---", "", "1. first", "2. second", "",
    "[docs]: https://example.com",
  ].join("\n");
  const blocks = renderBlocks(markdown, text);
  assert.equal(blocks.join(""), markdown.render(text));
  assert.equal(blocks.length, 7);
  assert.match(blocks[1], /href="https:\/\/example.com"/);
});

test("a growing reply only changes its last block", () => {
  const before = renderBlocks(markdown, "First paragraph.\n\nSecond para");
  const after = renderBlocks(markdown, "First paragraph.\n\nSecond paragraph, longer now.");
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
});
