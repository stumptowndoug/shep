import { Suspense, memo, use, useCallback, useContext, useDeferredValue, useMemo } from "react";
import { useThemeStore } from "../../stores/useThemeStore";
import { getMarkdownRenderer, getPlainMarkdownRenderer } from "../../lib/markdownRenderer";
import { fenceLanguages, loadLanguages, shikiThemeFor } from "../../lib/shikiHighlighter";
import { handleChatMarkdownClick, hydrateChatImages } from "./chatMarkdownDom";
import { ChatProjectPath } from "./chatProjectPath";
import ErrorBoundary from "../shared/ErrorBoundary";

/** Rendered markdown. Local images load once the text stops streaming. */
function MarkdownHtml({ html, loadImages }: { html: string; loadImages: boolean }) {
  const baseDir = useContext(ChatProjectPath);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node || !loadImages || !html.includes("chat-image--local")) return;
    return hydrateChatImages(node, baseDir);
  }, [html, loadImages, baseDir]);
  return <div ref={ref} className="chat-markdown" onClick={(event) => handleChatMarkdownClick(event, baseDir)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function HighlightedMarkdown({ text, themeName }: { text: string; themeName: string }) {
  const renderer = use(getMarkdownRenderer(themeName));
  // Less common languages load on first use; plain markdown shows meanwhile.
  const languages = loadLanguages(fenceLanguages(text));
  if (languages) use(languages);
  const html = useMemo(() => renderer.render(text), [renderer, text]);
  return <MarkdownHtml html={html} loadImages />;
}

function PlainMarkdown({ text, loadImages }: { text: string; loadImages: boolean }) {
  const html = useMemo(() => getPlainMarkdownRenderer().render(text), [text]);
  return <MarkdownHtml html={html} loadImages={loadImages} />;
}

/** Agent markdown with Shiki code blocks; plain until the highlighter loads. */
export default memo(function ChatMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const themeName = shikiThemeFor(theme);
  const deferredText = useDeferredValue(text);
  const renderedText = streaming ? deferredText : text;
  // Rich rendering must have a fixed budget even when an agent sends a huge response.
  if (renderedText.length > 24_000) {
    return <div className="chat-markdown">
      <details>
        <summary>Show large response as plain text ({renderedText.length.toLocaleString()} characters)</summary>
        <pre style={{ maxHeight: "36rem", overflow: "auto", whiteSpace: "pre-wrap" }}>{renderedText}</pre>
      </details>
    </div>;
  }
  if (streaming) return <PlainMarkdown text={renderedText} loadImages={false} />;
  // A highlighting failure shows the reply as plain markdown, never takes down the window.
  return (
    <ErrorBoundary resetKey={renderedText} fallback={() => <PlainMarkdown text={renderedText} loadImages />}>
      <Suspense fallback={<PlainMarkdown text={renderedText} loadImages />}>
        <HighlightedMarkdown text={renderedText} themeName={themeName} />
      </Suspense>
    </ErrorBoundary>
  );
});
