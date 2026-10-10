import { memo } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import {
  BookOpen,
  Brain,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  FilePen,
  Globe,
  Search,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import type { ChatItem, ToolDiff } from "../../lib/acp/chatModel";
import { useThemeStore } from "../../stores/useThemeStore";
import { getCodeViewCSSVariables, getDiffViewOptions } from "../git/codeViewTheme";

type ItemOf<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

const TOOL_OUTPUT_LINES = 16;

/** Present tense while live, past tense once done (Springroll's tool rows). */
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
      <MultiFileDiff
        oldFile={{ name, contents: diff.oldText ?? "" }}
        newFile={{ name, contents: diff.newText }}
        options={getDiffViewOptions(theme)}
        style={{ ...getCodeViewCSSVariables(), background: "transparent", color: "var(--text-primary)" }}
      />
    </div>
  );
}

function ToolRow({ item }: { item: ItemOf<"tool"> }) {
  const Icon = TOOL_ICONS[item.toolKind] ?? Wrench;
  const live = item.status === "pending" || item.status === "in_progress";
  const failed = item.status === "failed";
  const { verb, target } = toolParts(item.title, item.toolKind, live);
  const output = item.output.split("\n").slice(-TOOL_OUTPUT_LINES).join("\n").trim();
  const isCommand = item.toolKind === "execute";
  const hasBody = Boolean(output) || item.diffs.length > 0;
  const stats = item.diffs.length ? diffStats(item.diffs) : null;
  const className = `chat-tool ${live ? "chat-tool--live" : ""} ${failed ? "chat-tool--failed" : ""}`;
  const summary = (
    <>
      <Icon size={14} />
      {verb && <span className={`chat-tool__verb ${live ? "chat-shimmer" : ""}`}>{verb}</span>}
      <span className={`chat-tool__target ${isCommand ? "chat-tool__target--mono" : ""}`}>{target}</span>
      {stats && (
        <span className="chat-tool__deco">
          <span className="chat-tool__added">+{stats.added}</span> <span className="chat-tool__removed">−{stats.removed}</span>
        </span>
      )}
      {failed && <X size={13} />}
    </>
  );

  if (!hasBody) return <div className={className}><div className="chat-tool__row">{summary}</div></div>;
  return (
    <details className={className}>
      <summary className="chat-tool__row">{summary}</summary>
      <div className="chat-tool__body">
        {output && (
          <div className="chat-terminal">
            {isCommand && <div className="chat-terminal__cmd">{target}</div>}
            <pre className="chat-terminal__out">{output}</pre>
          </div>
        )}
        {item.diffs.map((diff, index) => <DiffBlock key={`${diff.path}-${index}`} diff={diff} />)}
      </div>
    </details>
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
        const Icon = entry.status === "completed" ? CircleCheck : entry.status === "in_progress" ? CircleDot : Circle;
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

export const ChatItemView = memo(function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "message":
      return <ChatMarkdown text={item.text} />;
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
