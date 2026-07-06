import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type Renderer from "markdown-it/lib/renderer.mjs";
import { fromHighlighter } from "@shikijs/markdown-it/core";
import type { HighlighterGeneric } from "shiki";
import { getHighlighter } from "./shikiHighlighter";

const cached = new Map<string, Promise<MarkdownIt>>();
let plainRenderer: MarkdownIt | null = null;

function createMarkdownRenderer(): MarkdownIt {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });

  const defaultLinkOpen =
    markdown.renderer.rules.link_open ??
    ((tokens: Token[], idx: number, options: any, _env: unknown, self: Renderer) =>
      self.renderToken(tokens, idx, options));

  markdown.renderer.rules.link_open = (
    tokens: Token[],
    idx: number,
    options: any,
    env: unknown,
    self: Renderer,
  ) => {
    const token = tokens[idx];
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noreferrer noopener");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return markdown;
}

export async function getMarkdownRenderer(theme: string): Promise<MarkdownIt> {
  if (!cached.has(theme)) {
    cached.set(theme, (async () => {
      const markdown = createMarkdownRenderer();
      const highlighter = await getHighlighter();
      markdown.use(
        fromHighlighter(highlighter as unknown as HighlighterGeneric<any, any>, {
          theme,
        }),
      );
      return markdown;
    })());
  }

  const markdown = await cached.get(theme)!;
  return markdown;
}

export function getPlainMarkdownRenderer(): MarkdownIt {
  if (!plainRenderer) {
    plainRenderer = createMarkdownRenderer();
  }
  return plainRenderer;
}

export function isMarkdownFile(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base.endsWith(".md") || base.endsWith(".markdown");
}
