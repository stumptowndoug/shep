import type { MarkdownIt } from "markdown-it";

/** Renders each top-level block on its own, so a streaming reply can keep the
 *  DOM of the blocks that haven't changed. The text is parsed as a whole first,
 *  so reference links and other cross-block syntax still resolve. */
export function renderBlocks(markdown: MarkdownIt, text: string): string[] {
  const env = {};
  const tokens = markdown.parse(text, env);
  const blocks: string[] = [];
  let start = 0;
  tokens.forEach((token, index) => {
    // A top-level block ends at its closing token, or is a single token (code, rules).
    if (token.level !== 0 || token.nesting === 1) return;
    blocks.push(markdown.renderer.render(tokens.slice(start, index + 1), markdown.options, env));
    start = index + 1;
  });
  return blocks;
}
