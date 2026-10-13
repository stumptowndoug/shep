import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { Turn, plural } from "./ChatTurn";
import { useNow, workerElapsed, workerStatus, WorkerStateIcon } from "./ChatWorkers";
import { lastOf } from "../../lib/acp/chatModel";
import type { ChatWorker } from "../../lib/acp/chatWorkers";

interface ChatWorkerPeekProps {
  worker: ChatWorker;
  /** Who started it: a parent agent's name, or the chat's own agent. */
  startedBy: string;
  waiting: boolean;
  onClose: () => void;
}

/** One delegated agent's transcript, beside the chat rather than inside it. */
export default function ChatWorkerPeek({ worker, startedBy, waiting, onClose }: ChatWorkerPeekProps) {
  const [copied, setCopied] = useState(false);
  const now = useNow(worker.state === "running");
  const turns = worker.chat.turns;
  const steps = turns.reduce((count, turn) => count + turn.items.filter(item => item.kind === "tool").length, 0);
  const meta = [workerStatus(worker, waiting), workerElapsed(worker, now), steps ? plural(steps, "step") : null, `started by ${startedBy}`]
    .filter(Boolean).join(" · ");
  const lastItems = lastOf(turns)?.items ?? [];
  const result = worker.state === "completed" ? [...lastItems].reverse().find(item => item.kind === "message") : undefined;
  const showTask = worker.task && worker.task !== turns[0]?.prompt;

  return <aside
    className="chat-peek"
    aria-label={`${worker.name} agent`}
    onKeyDown={(event) => {
      // Escape closes the peek here instead of stopping the chat's agent.
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }}
  >
    <div className="chat-peek__head">
      <button type="button" className="chat-peek__crumb" onClick={onClose}>Chat</button>
      <ChevronRight size={12} className="chat-peek__sep" aria-hidden="true" />
      <span className="chat-peek__name">{worker.name}</span>
      <button type="button" className="icon-btn" aria-label="Close agent" onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    <div className="chat-peek__meta">
      <WorkerStateIcon worker={worker} waiting={waiting} />
      <span>{meta}</span>
    </div>
    <div className="chat-peek__scroll" aria-label={`${worker.name} transcript`}>
      {showTask && <>
        <div className="chat-peek__label">Task</div>
        <div className="chat-peek__task">{worker.task}</div>
      </>}
      {worker.transcriptTrimmed && <p className="chat-notice">Showing retained recent activity.</p>}
      {worker.state === "disconnected" && <p className="chat-notice">The connection ended without a confirmed outcome.</p>}
      {turns.map(turn => <Turn key={turn.id} turn={turn} workOpen />)}
      {worker.state === "running" && !waiting && <div className="chat-working chat-shimmer">Working</div>}
      {!turns.some(turn => turn.items.length) && !worker.transcriptTrimmed && worker.state !== "running" && <p className="chat-notice">No activity reported.</p>}
    </div>
    {result?.kind === "message" && <div className="chat-peek__foot">
      <button type="button" className="btn-secondary" onClick={() => {
        void navigator.clipboard.writeText(result.text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }, () => setCopied(false));
      }}>{copied ? "Copied" : "Copy result"}</button>
    </div>}
  </aside>;
}
