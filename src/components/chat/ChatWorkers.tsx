import { useEffect, useState, type CSSProperties } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, ShieldAlert, Square } from "lucide-react";
import { workerTree, type ChatWorker } from "../../lib/acp/chatWorkers";
import type { RowRef } from "./backgroundRows";

const NO_WAITING: ReadonlySet<string> = new Set();

/** The current time, ticking each second while `active`, for live elapsed times. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function workerElapsed(worker: ChatWorker, now: number) {
  const seconds = Math.max(0, Math.floor(((worker.endedAt ?? now) - worker.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const STATE_LABELS = { running: "Running", completed: "Done", failed: "Failed", cancelled: "Stopped", disconnected: "Status unknown" };

export function workerStatus(worker: ChatWorker, waiting: boolean) {
  return waiting ? "Needs you" : STATE_LABELS[worker.state];
}

export function WorkerStateIcon({ worker, waiting }: { worker: ChatWorker; waiting: boolean }) {
  const tone = waiting ? "waiting" : worker.state;
  const className = `chat-agent__icon chat-agent__icon--${tone}`;
  if (waiting) return <ShieldAlert size={13} className={className} aria-hidden="true" />;
  switch (worker.state) {
    case "running": return <span className={`${className} chat-agent__dot`} aria-hidden="true" />;
    case "completed": return <Check size={13} strokeWidth={2.4} className={className} aria-hidden="true" />;
    case "failed": return <CircleAlert size={13} className={className} aria-hidden="true" />;
    case "cancelled": return <Square size={11} className={className} aria-hidden="true" />;
    case "disconnected": return <CircleHelp size={13} className={className} aria-hidden="true" />;
  }
}

interface ChatAgentGroupProps {
  workers: ChatWorker[];
  waiting?: ReadonlySet<string>;
  openId: string | null;
  onOpen: (sessionId: string | null) => void;
  /** Registers the group for the jump shortcut while it has running agents. */
  trackRef?: RowRef;
}

/** Agents a turn delegated to, folded like its work: one quiet row each. */
export function ChatAgentGroup({ workers, waiting = NO_WAITING, openId, onOpen, trackRef }: ChatAgentGroupProps) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const running = workers.filter(worker => worker.state === "running").length;
  const needsYou = workers.filter(worker => waiting.has(worker.sessionId)).length;
  const done = workers.filter(worker => worker.state === "completed").length;
  const open = expanded ?? (running > 0 || needsYou > 0 || workers.some(worker => worker.sessionId === openId));
  const now = useNow(open && running > 0);
  const facts = [
    running ? `${running} running` : null,
    needsYou ? `${needsYou} needs you` : null,
    done && done < workers.length ? `${done} done` : null,
  ].filter(Boolean).join(" · ");
  const title = `${workers.length} ${workers.length === 1 ? "agent" : "agents"}`;

  return <details ref={running > 0 ? trackRef : undefined} className="chat-agents" open={open} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <ChevronRight size={14} className="chat-worked__chevron" aria-hidden="true" />
      <span>{title}</span>
      {facts && <span className="chat-worked__facts">{facts}</span>}
    </summary>
    {open && <div className="chat-agents__items">
      {workerTree(workers).map(({ worker, depth }) => {
        const isWaiting = waiting.has(worker.sessionId);
        const status = workerStatus(worker, isWaiting);
        const time = workerElapsed(worker, now);
        const selected = openId === worker.sessionId;
        const quiet = worker.state === "running" && !isWaiting;
        return <button
          key={worker.sessionId}
          type="button"
          className={`chat-agent chat-agent--${isWaiting ? "waiting" : worker.state}`}
          style={{ "--depth": depth } as CSSProperties}
          aria-pressed={selected}
          aria-label={`${worker.name}, ${status}, ${time}`}
          onClick={() => onOpen(selected ? null : worker.sessionId)}
        >
          <span className="chat-agent__row">
            <WorkerStateIcon worker={worker} waiting={isWaiting} />
            <span className="chat-agent__name">{worker.name}</span>
            {worker.task && <span className="chat-agent__task">{worker.task}</span>}
            <span className="chat-agent__deco">
              {!quiet && worker.state !== "completed" && <span className="chat-agent__status">{status}</span>}
              <span>{time}</span>
            </span>
          </span>
          {quiet && worker.lastActivity && <span className="chat-agent__activity chat-shimmer">{worker.lastActivity}</span>}
        </button>;
      })}
    </div>}
  </details>;
}
