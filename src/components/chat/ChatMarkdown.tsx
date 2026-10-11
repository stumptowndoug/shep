import { Suspense, memo, use, useDeferredValue, useMemo } from "react";
import { useThemeStore } from "../../stores/useThemeStore";
import { getMarkdownRenderer, getPlainMarkdownRenderer } from "../../lib/markdownRenderer";
import { shikiThemeFor } from "../../lib/shikiHighlighter";

function HighlightedMarkdown({ text, themeName }: { text: string; themeName: string }) {
  const renderer = use(getMarkdownRenderer(themeName));
  const html = useMemo(() => renderer.render(text), [renderer, text]);
  return <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PlainMarkdown({ text }: { text: string }) {
  const html = useMemo(() => getPlainMarkdownRenderer().render(text), [text]);
  return <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
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
  if (streaming) return <PlainMarkdown text={renderedText} />;
  return (
    <Suspense fallback={<PlainMarkdown text={renderedText} />}>
      <HighlightedMarkdown text={renderedText} themeName={themeName} />
    </Suspense>
  );
});
