import { memo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ChatErrorNotice, ChatItemView, CopyButton, TurnChanges, workStatus } from "./ChatItems";
import { ChatAgentGroup } from "./ChatWorkers";
import { ChatTaskRows } from "./ChatTasks";
import type { RowRef } from "./backgroundRows";
import type { ChatItem, ChatTurn, PromptImage } from "../../lib/acp/chatModel";
import type { ChatWorker } from "../../lib/acp/chatWorkers";
import type { ChatTask } from "../../lib/acp/chatTasks";
import { lastWorkIndex, turnChanges, turnSegments, turnStopMessage } from "../../lib/acp/chatPresentation";

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Images sent with a prompt, above its bubble. */
export function PromptImages({ images = [], trimmed = 0 }: { images?: PromptImage[]; trimmed?: number }) {
  if (!images.length && !trimmed) return null;
  return (
    <div className="chat-user-images">
      {images.map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? `Image ${index + 1}`} loading="lazy" decoding="async" />
      ))}
      {trimmed > 0 && <span className="chat-user-images__trimmed">{plural(trimmed, "image")} sent</span>}
    </div>
  );
}

interface TurnProps {
  turn: ChatTurn;
  /** Agents started in this turn; they sit after its last work, before its answer. */
  workers?: ChatWorker[];
  waiting?: ReadonlySet<string>;
  openWorkerId?: string | null;
  onOpenWorker?: (sessionId: string | null) => void;
  /** Commands started in this turn that went on in the background. */
  tasks?: ChatTask[];
  chatId?: number;
  openTaskKey?: string | null;
  onOpenTask?: (key: string | null) => void;
  /** Registers rows of running background work for the jump shortcut. */
  track?: (key: string) => RowRef;
  /** Start with the work shown, where it's what the reader came for. */
  workOpen?: boolean;
}

interface WorkFoldProps {
  items: ChatItem[];
  /** The turn is running and this is its newest row. */
  live: boolean;
  /** The whole turn's time, on its last row once it ends. */
  duration: string | null;
  defaultOpen: boolean;
}

/** One run of thoughts and tools between the agent's messages, folded to a row. */
function WorkFold({ items, live, duration, defaultOpen }: WorkFoldProps) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? defaultOpen;
  const tools = items.filter((item) => item.kind === "tool");
  const edits = tools.filter((item) => item.kind === "tool" && item.toolKind === "edit").length;
  const facts = [
    duration,
    tools.length > 0 ? plural(tools.length, "step") : null,
    edits > 0 ? plural(edits, "edit") : null,
  ].filter(Boolean).join(" · ");
  const status = live ? workStatus(items[items.length - 1]) : null;
  const label = live ? "Working" : items.every((item) => item.kind === "thought") ? "Thought" : "Worked";
  return (
    <details className="chat-worked" open={open} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} className="chat-worked__chevron" />
        <span className={live ? "chat-shimmer" : undefined}>{label}</span>
        {status && <span className="chat-worked__status">
          <status.Icon size={13} aria-hidden="true" />
          <span>{status.text}</span>
        </span>}
        {facts && <span className="chat-worked__facts">{facts}</span>}
      </summary>
      {open && <div className="chat-worked__items">
        {items.map((item) => <ChatItemView key={item.id} item={item} />)}
      </div>}
    </details>
  );
}

export const Turn = memo(function Turn({ turn, workers, waiting, openWorkerId = null, onOpenWorker, tasks, chatId, openTaskKey = null, onOpenTask, track, workOpen = false }: TurnProps) {
  const segments = turnSegments(turn);
  const lastWork = lastWorkIndex(segments);
  const live = turn.endedAt === null;
  const stopMessage = turnStopMessage(turn);
  // Summarize changes once the turn is done, so the list doesn't grow under the reader.
  const changes = turn.endedAt === null ? [] : turnChanges(turn);
  // The answer as the agent wrote it, Markdown and all: its messages after the last row of work.
  const answerText = turn.endedAt === null ? "" : segments.slice(lastWork + 1)
    .flatMap((segment) => segment.kind === "item" && segment.item.kind === "message" ? [segment.item.text] : []).join("\n\n").trim();
  // A running turn's clock would only tick on new output, so it shows once the turn ends.
  const duration = live ? null : formatDuration(turn.endedAt! - turn.startedAt);
  const agents = workers && workers.length > 0 && onOpenWorker
    ? <ChatAgentGroup key="agents" workers={workers} waiting={waiting} openId={openWorkerId} onOpen={onOpenWorker} trackRef={track?.(`agents:${turn.id}`)} />
    : null;
  const background = tasks && tasks.length > 0 && onOpenTask && chatId !== undefined
    ? <ChatTaskRows key="tasks" chatId={chatId} tasks={tasks} openId={openTaskKey} onOpen={onOpenTask} track={track} />
    : null;
  // Agents and background commands started in the turn sit after its last row of work, before the answer.
  const rows: ReactNode[] = lastWork === -1 ? [agents, background] : [];
  segments.forEach((segment, index) => {
    rows.push(segment.kind === "work"
      ? <WorkFold key={segment.id} items={segment.items} live={live && index === segments.length - 1}
        duration={index === lastWork ? duration : null}
        // Agents recover from failed tools on their own; only a failed turn opens its last work.
        defaultOpen={workOpen || (turn.stopReason === "error" && index === lastWork)} />
      : <ChatItemView key={segment.item.id} item={segment.item} streaming={live} />);
    if (index === lastWork) rows.push(agents, background);
  });
  return (
    <div className="chat-turn">
      <PromptImages images={turn.images} trimmed={turn.trimmedImages} />
      {turn.prompt && <div className="chat-user">{turn.prompt}</div>}
      {turn.additionalPrompts?.map((text, index) => <div key={index} className="chat-user">{text}</div>)}
      {rows}
      {changes.length > 0 && <TurnChanges changes={changes} />}
      {answerText && <div className="chat-turn__actions"><CopyButton text={answerText} label="Copy response" /></div>}
      {stopMessage && (turn.stopReason === "error" ? <ChatErrorNotice text={stopMessage} /> : <div className="chat-notice">{stopMessage}</div>)}
    </div>
  );
});
