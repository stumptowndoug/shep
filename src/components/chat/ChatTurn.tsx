import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ChatErrorNotice, ChatItemView, CopyButton, TurnChanges, workStatus } from "./ChatItems";
import { ChatAgentGroup } from "./ChatWorkers";
import type { ChatTurn, PromptImage } from "../../lib/acp/chatModel";
import type { ChatWorker } from "../../lib/acp/chatWorkers";
import { splitTurn, turnChanges, turnStopMessage } from "../../lib/acp/chatPresentation";

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
  /** Agents started in this turn; they sit between its work and its answer. */
  workers?: ChatWorker[];
  waiting?: ReadonlySet<string>;
  openWorkerId?: string | null;
  onOpenWorker?: (sessionId: string | null) => void;
  /** Start with the work shown, where it's what the reader came for. */
  workOpen?: boolean;
}

export const Turn = memo(function Turn({ turn, workers, waiting, openWorkerId = null, onOpenWorker, workOpen = false }: TurnProps) {
  const { work, answer } = splitTurn(turn);
  const live = turn.endedAt === null;
  const tools = work.filter((item) => item.kind === "tool");
  const [workExpanded, setWorkExpanded] = useState<boolean | null>(null);
  // Agents recover from failed tools on their own; only a failed turn opens its work.
  const showWork = workExpanded ?? (workOpen || turn.stopReason === "error");
  const stopMessage = turnStopMessage(turn);
  // Summarize changes once the turn is done, so the list doesn't grow under the reader.
  const changes = turn.endedAt === null ? [] : turnChanges(turn);
  // The answer as the agent wrote it, Markdown and all.
  const answerText = turn.endedAt === null ? "" : answer.flatMap((item) => item.kind === "message" ? [item.text] : []).join("\n\n").trim();
  const edits = tools.filter((item) => item.kind === "tool" && item.toolKind === "edit").length;
  // A running turn's clock would only tick on new output, so it shows once the turn ends.
  const facts = [
    live ? null : formatDuration(turn.endedAt! - turn.startedAt),
    tools.length > 0 ? plural(tools.length, "step") : null,
    edits > 0 ? plural(edits, "edit") : null,
  ].filter(Boolean).join(" · ");
  const status = live && work.length > 0 ? workStatus(work[work.length - 1]) : null;
  return (
    <div className="chat-turn">
      <PromptImages images={turn.images} trimmed={turn.trimmedImages} />
      {turn.prompt && <div className="chat-user">{turn.prompt}</div>}
      {turn.additionalPrompts?.map((text, index) => <div key={index} className="chat-user">{text}</div>)}
      {work.length > 0 && (
        <details className="chat-worked" open={showWork} onToggle={(event) => setWorkExpanded(event.currentTarget.open)}>
          <summary>
            <ChevronRight size={14} className="chat-worked__chevron" />
            <span className={live ? "chat-shimmer" : undefined}>{live ? "Working" : "Worked"}</span>
            {status && <span className="chat-worked__status">
              <status.Icon size={13} aria-hidden="true" />
              <span>{status.text}</span>
            </span>}
            {facts && <span className="chat-worked__facts">{facts}</span>}
          </summary>
          {showWork && <div className="chat-worked__items">
            {work.map((item) => <ChatItemView key={item.id} item={item} streaming={live} />)}
          </div>}
        </details>
      )}
      {workers && workers.length > 0 && onOpenWorker && (
        <ChatAgentGroup workers={workers} waiting={waiting} openId={openWorkerId} onOpen={onOpenWorker} />
      )}
      {answer.map((item) => <ChatItemView key={item.id} item={item} streaming={live} />)}
      {changes.length > 0 && <TurnChanges changes={changes} />}
      {answerText && <div className="chat-turn__actions"><CopyButton text={answerText} label="Copy response" /></div>}
      {stopMessage && (turn.stopReason === "error" ? <ChatErrorNotice text={stopMessage} /> : <div className="chat-notice">{stopMessage}</div>)}
    </div>
  );
});
