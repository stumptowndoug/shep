import { memo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import {
  BookOpen,
  ClipboardList,
  Brain,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  FilePen,
  Globe,
  Link,
  MessageCircle,
  Search,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import { errorTone, textDiffLines } from "../../lib/acp/chatPresentation";
import type { ChatItem, ToolDiff } from "../../lib/acp/chatModel";
import { useThemeStore } from "../../stores/useThemeStore";
import { getCodeViewCSSVariables, getDiffViewOptions } from "../git/codeViewTheme";
import { openUrl } from "../../lib/tauri";

type ItemOf<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

const TOOL_OUTPUT_LINES = 16;

/** Present tense while live, past tense once done (Springroll's tool rows).
 * A failed tool keeps its past tense: agents recover from most failures
 * (a nonzero exit, a search with no match), so it reads as ordinary work. */
const TOOL_VERBS: Record<string, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"],
  move: ["Moving", "Moved"],
  search: ["Searching", "Searched"],
  execute: ["Running", "Ran"],
  fetch: ["Fetching", "Fetched"],
  think: ["Thinking", "Thought"],
};

/** Leading words agents put in titles that the verb already says. */
const TITLE_VERB = /^(read|reading|edit|editing|write|writing|search|searching|grep|glob|find|run|running|fetch|fetching|delete|move)\b\s*/i;

function toolParts(title: string, toolKind: string, live: boolean) {
  const verbs = TOOL_VERBS[toolKind];
  if (!verbs) return { verb: null, target: title };
  const target = toolKind === "execute" ? title.replace(/^`|`$/g, "") : title.replace(TITLE_VERB, "") || title;
  return { verb: verbs[live ? 0 : 1], target };
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: BookOpen,
  edit: FilePen,
  delete: Trash2,
  move: FilePen,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
};

/** Rough +/- line counts for a diff summary. */
function diffStats(diffs: ToolDiff[]) {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    if (diff.truncated) continue;
    const before = new Set((diff.oldText ?? "").split("\n"));
    const after = new Set(diff.newText.split("\n"));
    for (const line of after) if (!before.has(line)) added += 1;
    for (const line of before) if (line && !after.has(line)) removed += 1;
  }
  return { added, removed };
}

function DiffBlock({ diff }: { diff: ToolDiff }) {
  const theme = useThemeStore((s) => s.theme);
  const name = diff.path.split("/").pop() ?? diff.path;
  return (
    <div className="chat-diff">
      <div className="chat-diff__path">{diff.path}</div>
      {diff.truncated ? <div className="chat-diff__omitted">Large diff omitted. Review the file in your editor.</div> : <MultiFileDiff
        oldFile={{ name, contents: diff.oldText ?? "" }}
        newFile={{ name, contents: diff.newText }}
        options={getDiffViewOptions(theme)}
        style={{ ...getCodeViewCSSVariables(), background: "transparent", color: "var(--text-primary)" }}
      />}
    </div>
  );
}

function ToolRow({ item }: { item: ItemOf<"tool"> }) {
  const Icon = TOOL_ICONS[item.toolKind] ?? Wrench;
  const live = item.status === "pending" || item.status === "in_progress";
  const failed = item.status === "failed";
  const [open, setOpen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const { verb, target } = toolParts(item.title, item.toolKind, live);
  const lines = item.output.trimEnd().split("\n");
  const earlier = Math.max(0, lines.length - TOOL_OUTPUT_LINES);
  const output = (showEarlier ? lines : lines.slice(-TOOL_OUTPUT_LINES)).join("\n");
  const isCommand = item.toolKind === "execute";
  const hasBody = Boolean(output) || item.diffs.length > 0 || item.outputTrimmed;
  // Agents that report an edit as a text diff still get colored lines and counts.
  const textDiff = isCommand ? null : textDiffLines(output);
  const stats = item.diffs.some((diff) => !diff.truncated) ? diffStats(item.diffs)
    : textDiff ? {
      added: textDiff.filter((line) => line.kind === "add").length,
      removed: textDiff.filter((line) => line.kind === "remove").length,
    } : null;
  const className = `chat-tool ${live ? "chat-tool--live" : ""}`;
  const summary = (
    <>
      <Icon size={14} />
      {verb && <span className={`chat-tool__verb ${live ? "chat-shimmer" : ""}`}>{verb}</span>}
      <span className={`chat-tool__target ${isCommand ? "chat-tool__target--mono" : ""}`}>{target}</span>
      {(stats || failed) && (
        <span className="chat-tool__deco">
          {stats && <><span className="chat-tool__added">+{stats.added}</span> <span className="chat-tool__removed">−{stats.removed}</span></>}
          {stats && failed && " · "}
          {failed && <span className="chat-tool__failed">failed</span>}
        </span>
      )}
    </>
  );

  if (!hasBody) return <div className={className}><div className="chat-tool__row">{summary}</div></div>;
  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="chat-tool__row">{summary}</summary>
      {open && <div className="chat-tool__body">
        {item.outputTrimmed && <div className="chat-diff__omitted">Tool output and diffs trimmed from older history to reduce memory use.</div>}
        {output && (
          <div className="chat-terminal">
            {isCommand && <div className="chat-terminal__cmd">{target}</div>}
            {earlier > 0 && <button type="button" className="chat-terminal__earlier" onClick={() => setShowEarlier(!showEarlier)}>
              {showEarlier ? "Show fewer lines" : `Show ${earlier} earlier lines`}
            </button>}
            {textDiff
              ? <pre className="chat-terminal__out chat-terminal__out--diff">{textDiff.map((line, index) => (
                <span key={index} className={`chat-diff-line chat-diff-line--${line.kind}`}>{line.text}{"\n"}</span>
              ))}</pre>
              : <pre className="chat-terminal__out">{output}</pre>}
          </div>
        )}
        {item.diffs.map((diff, index) => <DiffBlock key={`${diff.path}-${index}`} diff={diff} />)}
        {Boolean(item.omittedDiffs) && <div className="chat-diff__omitted">{item.omittedDiffs} more file changes omitted. Review them in your editor.</div>}
      </div>}
    </details>
  );
}

/** A turn or session that stopped: one plain line, its icon carrying the tone. */
export function ChatErrorNotice({ text }: { text: string }) {
  return (
    <div className={`chat-notice chat-notice--${errorTone(text)}`}>
      <CircleAlert size={14} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function PlanCard({ item }: { item: ItemOf<"plan"> }) {
  const done = item.entries.filter((entry) => entry.status === "completed").length;
  return (
    <div className="chat-plan">
      <div className="chat-plan__head">
        <span>Plan</span>
        <span className="chat-plan__count">{done}/{item.entries.length}</span>
      </div>
      {item.entries.map((entry, index) => {
        const Icon = entry.status === "completed" ? CircleCheck : entry.status === "cancelled" ? X : entry.status === "in_progress" ? CircleDot : Circle;
        return (
          <div key={index} className={`chat-plan__entry chat-plan__entry--${entry.status}`}>
            <Icon size={14} />
            <span>{entry.content}</span>
          </div>
        );
      })}
    </div>
  );
}

function PermissionResult({ item }: { item: ItemOf<"permission"> }) {
  const option = item.options.find((entry) => entry.optionId === item.chosen);
  const allowed = option?.kind.startsWith("allow") ?? false;
  return (
    <div className="chat-tool">
      <div className="chat-tool__row">
        {allowed ? <Check size={14} /> : <ShieldAlert size={14} />}
        <span className="chat-tool__verb">{allowed ? "Allowed" : "Declined"}</span>
        <span className="chat-tool__target">{item.title}</span>
      </div>
    </div>
  );
}

export const ChatItemView = memo(function ChatItemView({ item, streaming = false }: { item: ChatItem; streaming?: boolean }) {
  switch (item.kind) {
    case "message":
      return <ChatMarkdown text={item.text} streaming={streaming} />;
    case "media":
      return item.content.type === "image"
        ? <img className="chat-media" src={`data:${item.content.mimeType};base64,${item.content.data}`} alt="Agent output" loading="lazy" decoding="async" />
        : <a className="chat-resource" href={item.content.uri} target="_blank" rel="noopener noreferrer" onClick={(event) => {
          event.preventDefault();
          if (item.content.type === "resource_link") void openUrl(item.content.uri);
        }}><Link size={14} /><span>{item.content.name}</span></a>;
    case "thought":
      return (
        <details className="chat-tool chat-thought">
          <summary className="chat-tool__row">
            <Brain size={14} />
            <span className="chat-tool__verb">Thought</span>
            <span className="chat-tool__target">{item.text.split("\n")[0]}</span>
          </summary>
          <div className="chat-thought__text">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanCard item={item} />;
    case "cursor_request": {
      if (!item.outcome) return null;
      const isPlan = item.request.kind === "plan";
      const Icon = isPlan ? ClipboardList : MessageCircle;
      const label = item.outcome.outcome === "accepted" ? "Plan accepted" : item.outcome.outcome === "rejected" ? "Plan rejected"
        : item.outcome.outcome === "answered" ? "Answered" : item.outcome.outcome === "skipped" ? "Skipped" : "Cancelled";
      const answers = item.outcome.outcome === "answered" ? item.outcome.answers : [];
      return <details className="chat-tool">
        <summary className="chat-tool__row"><Icon size={14} /><span className="chat-tool__verb">{label}</span><span className="chat-tool__target">{item.request.title}</span></summary>
        <div className="chat-tool__body">
          {item.request.kind === "plan" ? <ChatMarkdown text={item.request.plan} /> : item.request.questions.map(question => <div key={question.id}>
            <div>{question.prompt}</div>
            <div className="chat-question__hint">{question.options.filter(option => answers.find(answer => answer.questionId === question.id)?.selectedOptionIds.includes(option.id)).map(option => option.label).join(", ") || "No answer"}</div>
          </div>)}
        </div>
      </details>;
    }
    case "permission":
      // Pending requests render as the approval card above the composer.
      return item.chosen === null ? null : <PermissionResult item={item} />;
    case "notice":
      return (
        <div className="chat-notice">
          <CircleAlert size={14} />
          <span>{item.text}</span>
        </div>
      );
  }
});
