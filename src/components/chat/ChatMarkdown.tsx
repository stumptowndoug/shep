import { Suspense, memo, use, useCallback, useContext, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useThemeStore } from "../../stores/useThemeStore";
import { getMarkdownRenderer, getPlainMarkdownRenderer } from "../../lib/markdownRenderer";
import { renderBlocks } from "../../lib/markdownBlocks";
import { fenceLanguages, loadLanguages, shikiThemeFor } from "../../lib/shikiHighlighter";
import { handleChatMarkdownClick, hydrateChatImages } from "./chatMarkdownDom";
import { ChatProjectPath } from "./chatProjectPath";
import ErrorBoundary from "../shared/ErrorBoundary";

/** One top-level markdown block. Memoized, so while a reply streams the blocks
 *  that haven't changed keep their DOM: WebKit loses the chat's scroll position
 *  when the content near it is torn down and rebuilt. */
const MarkdownBlock = memo(function MarkdownBlock({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Rendered markdown, plain or highlighted. One component either way, so a reply
 *  finishing only changes the blocks highlighting changes. Local images load
 *  once the text stops streaming. */
function Markdown({ text, themeName, loadImages }: { text: string; themeName: string | null; loadImages: boolean }) {
  const baseDir = useContext(ChatProjectPath);
  const renderer = themeName ? use(getMarkdownRenderer(themeName)) : getPlainMarkdownRenderer();
  // Less common languages load on first use; plain markdown shows meanwhile.
  const languages = themeName ? loadLanguages(fenceLanguages(text)) : null;
  if (languages) use(languages);
  const blocks = useMemo(() => renderBlocks(renderer, text), [renderer, text]);
  const hasLocalImages = loadImages && blocks.some((html) => html.includes("chat-image--local"));
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node || !hasLocalImages) return;
    return hydrateChatImages(node, baseDir);
  }, [hasLocalImages, baseDir, blocks]);
  return (
    <div ref={ref} className="chat-markdown" onClick={(event) => handleChatMarkdownClick(event, baseDir)}>
      {blocks.map((html, index) => <MarkdownBlock key={index} html={html} />)}
    </div>
  );
}

/** Past this, a finished reply shows as plain text: re-parsing it for markdown
 *  costs about 10ms per update at this size. */
const LARGE_REPLY = 100_000;

/** Reveal speed: a share of the backlog each frame, so a burst clears in about a
 *  second, but never slower than a quick reading pace. */
const REVEAL_FRAMES = 30;
const MIN_REVEAL_CHARS = 3;

/** How much of a reply to show. Agents often send text in bursts; a reply that
 *  arrives while you watch is shown at a steady pace instead, and keeps going
 *  after the turn ends until it has caught up. Replies already there show whole. */
function useRevealedLength(text: string, streaming: boolean): number {
  const [shown, setShown] = useState(streaming ? 0 : text.length);
  useEffect(() => {
    if (shown >= text.length) return;
    const frame = requestAnimationFrame(() => setShown((count) => {
      const backlog = text.length - count;
      return count + Math.min(backlog, Math.max(MIN_REVEAL_CHARS, Math.ceil(backlog / REVEAL_FRAMES)));
    }));
    return () => cancelAnimationFrame(frame);
  }, [shown, text.length]);
  return Math.min(shown, text.length);
}

/** Agent markdown with Shiki code blocks; plain until the highlighter loads. */
export default memo(function ChatMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const themeName = shikiThemeFor(theme);
  const shown = useRevealedLength(text, streaming);
  const live = streaming || shown < text.length;
  const deferredText = useDeferredValue(text.slice(0, shown));
  const renderedText = live ? deferredText : text;
  // Deferred, so if highlighting still has to load, the plain reply stays on
  // screen instead of being hidden for a fallback copy.
  const highlightTheme = useDeferredValue(live ? null : themeName);
  // Rich rendering needs a budget for huge replies. Applied once the reply is
  // done, so it never changes form while it streams in.
  if (!live && text.length > LARGE_REPLY) {
    return <div className="chat-markdown"><p className="chat-markdown__plain">{text}</p></div>;
  }
  // Plain while it streams, highlighted once done; the same tree throughout. A
  // highlighting failure shows the reply as plain markdown, never takes down the window.
  return (
    <ErrorBoundary resetKey={renderedText} fallback={() => <Markdown text={renderedText} themeName={null} loadImages={!live} />}>
      <Suspense fallback={<Markdown text={renderedText} themeName={null} loadImages={!live} />}>
        <Markdown text={renderedText} themeName={highlightTheme} loadImages={!live} />
      </Suspense>
    </ErrorBoundary>
  );
});
