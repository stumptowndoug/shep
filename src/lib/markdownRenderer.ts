import markdownit, { type MarkdownIt, type RendererRule } from "markdown-it";
import { fromHighlighter } from "@shikijs/markdown-it/core";
import type { HighlighterGeneric } from "shiki";
import { canonicalLang, getHighlighter } from "./shikiHighlighter";
import { chatImageHtml } from "./acp/chatImages";

const cached = new Map<string, Promise<MarkdownIt>>();
let plainRenderer: MarkdownIt | null = null;

function createMarkdownRenderer(): MarkdownIt {
  const markdown = markdownit({
    html: false,
    linkify: true,
    typographer: true,
  });

  // Markdown-it 15 disables bare-domain links by default; preserve Shep's
  // previous linkification behavior while keeping fuzzy IP matching disabled.
  markdown.linkify.set({ fuzzyLink: true });

  const defaultLinkOpen: RendererRule =
    markdown.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  // Agents often reference screenshots by file:// URL; markdown-it rejects that scheme.
  const defaultValidateLink = markdown.validateLink;
  markdown.validateLink = (url) => defaultValidateLink(url) || /^file:\/\//i.test(url.trim());

  markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    return chatImageHtml(String(token.attrGet("src") ?? ""), alt, markdown.utils.escapeHtml);
  };

  markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noreferrer noopener");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return markdown;
}

/** Returns the same promise per theme, so callers can pass it to React's `use`. */
export function getMarkdownRenderer(theme: string): Promise<MarkdownIt> {
  if (!cached.has(theme)) {
    cached.set(theme, (async () => {
      const markdown = createMarkdownRenderer();
      const highlighter = await getHighlighter();
      markdown.use(
        fromHighlighter(highlighter as unknown as HighlighterGeneric<any, any>, {
          theme,
        }),
      );
      // Shiki throws on a language it hasn't loaded, and agents name any language.
      // Checked per block, not once, because languages also load on demand.
      const highlight = markdown.options.highlight!;
      markdown.options.highlight = (code, lang, attrs) => {
        const name = canonicalLang(lang);
        const known = name === "" || highlighter.getLoadedLanguages().includes(name);
        return highlight(code, known ? name : "text", attrs);
      };
      return markdown;
    })());
  }

  return cached.get(theme)!;
}

export function getPlainMarkdownRenderer(): MarkdownIt {
  if (!plainRenderer) {
    plainRenderer = createMarkdownRenderer();
  }
  return plainRenderer;
}
