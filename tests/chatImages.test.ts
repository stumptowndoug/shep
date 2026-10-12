import test from "node:test";
import assert from "node:assert/strict";
import { chatImageHtml, classifyImageSource, resolveImagePath } from "../src/lib/acp/chatImages.ts";

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("image sources: data images inline, web images as links, everything else local", () => {
  assert.equal(classifyImageSource("data:image/png;base64,AAAA").kind, "inline");
  assert.equal(classifyImageSource("data:image/svg+xml;base64,AAAA").kind, "local");
  assert.equal(classifyImageSource("https://example.com/a.png").kind, "remote");
  assert.deepEqual(classifyImageSource("/tmp/My%20Shot.png"), { kind: "local", path: "/tmp/My Shot.png" });
  assert.deepEqual(classifyImageSource("%E0%A4%A"), { kind: "local", path: "%E0%A4%A" });
});

test("remote images never load: they render as a link chip", () => {
  const html = chatImageHtml("https://tracker.example/pixel.png", "Preview", escape);
  assert.match(html, /^<a class="chat-image chat-image--link" href="https:\/\/tracker\.example\/pixel\.png"/);
  assert.doesNotMatch(html, /<img/);
});

test("local images render a placeholder carrying the escaped path and alt text", () => {
  const html = chatImageHtml("/tmp/a\"b.png", "<script>", escape);
  assert.match(html, /data-path="\/tmp\/a&quot;b\.png"/);
  assert.match(html, /data-alt="&lt;script&gt;"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(chatImageHtml("shot.png", "  ", escape), />Image<\/span>/);
});

test("open targets resolve relative paths against the project", () => {
  assert.equal(resolveImagePath("/abs/a.png", "/repo"), "/abs/a.png");
  assert.equal(resolveImagePath("file:///abs/a.png", "/repo"), "/abs/a.png");
  assert.equal(resolveImagePath("./shots/a.png", "/repo/"), "/repo/shots/a.png");
  assert.equal(resolveImagePath("~/a.png", "/repo"), null);
});
