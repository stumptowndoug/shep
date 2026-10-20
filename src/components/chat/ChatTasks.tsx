import { useEffect, useState } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, LoaderCircle, Square, X } from "lucide-react";
import { useNow } from "./ChatWorkers";
import { stopBackgroundTask } from "../../lib/acp/chatSessions";
import { taskTitle, type ChatTask } from "../../lib/acp/chatTasks";
import { readTaskOutput, type TaskOutput } from "../../lib/tauri";
import type { ChatItem } from "../../lib/acp/chatModel";
import { getErrorMessage } from "../../lib/errors";
import type { RowRef } from "./backgroundRows";
import { useNoticeStore } from "../../stores/useNoticeStore";

/** How often an open task's output file is read while the command runs. */
const OUTPUT_POLL_MS = 2000;

const STATE_LABELS: Record<string, string> = {
  running: "In background", completed: "Done", failed: "Failed", stopped: "Stopped", disconnected: "Status unknown", paused: "Paused",
};

export function taskStatus(task: ChatTask) {
  return STATE_LABELS[task.state] ?? task.state;
}

export function taskElapsed(task: ChatTask, now: number) {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Generic names agents give a task ("Bash", "Background task") say nothing the command doesn't. */
const GENERIC_NAMES = new Set(["", "bash", "shell", "background task", "task"]);

function taskName(task: ChatTask) {
  return GENERIC_NAMES.has(task.name.toLowerCase()) || task.name === task.description ? "Background command" : task.name;
}

/** The key a task's row is tracked by, for the jump shortcut. */
export function taskRowKey(task: ChatTask) {
  return `task:${task.ownerSessionId ?? ""}:${task.id}`;
}

function TaskStateIcon({ task }: { task: ChatTask }) {
  const className = `chat-agent__icon chat-agent__icon--${task.state === "stopped" ? "cancelled" : task.state}`;
  switch (task.state) {
    case "running": return <span className={`${className} chat-agent__dot`} aria-hidden="true" />;
    case "completed": return <Check size={13} strokeWidth={2.4} className={className} aria-hidden="true" />;
    case "failed": return <CircleAlert size={13} className={className} aria-hidden="true" />;
    case "stopped": return <Square size={11} className={className} aria-hidden="true" />;
    default: return <CircleHelp size={13} className={className} aria-hidden="true" />;
  }
}

/** Ask the agent to stop a task; a refusal or failure becomes a notice. */
function useStopTask(chatId: number) {
  const [stopping, setStopping] = useState<string | null>(null);
  const stop = (task: ChatTask) => {
    if (stopping) return;
    setStopping(task.id);
    void stopBackgroundTask(chatId, task).then(stopped => {
      if (!stopped) useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn’t stop the command", message: "The agent says it already finished or can’t be stopped." });
    }, error => {
      useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn’t stop the command", message: getErrorMessage(error) });
    }).finally(() => setStopping(null));
  };
  return { stopping, stop };
}

function StopButton({ task, stopping, onStop, label = "Stop" }: { task: ChatTask; stopping: boolean; onStop: () => void; label?: string }) {
  if (task.state !== "running" || !task.canStop) return null;
  return <button type="button" className="btn-secondary chat-task__stop" disabled={stopping} aria-label={`Stop ${taskTitle(task)}`} onClick={onStop}>
    {stopping ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> : <Square size={10} aria-hidden="true" />}
    {label}
  </button>;
}

interface ChatTaskRowsProps {
  chatId: number;
  tasks: ChatTask[];
  openId: string | null;
  onOpen: (key: string | null) => void;
  /** Registers a row for the jump shortcut. */
  track?: (key: string) => RowRef;
}

/** Commands the agent left running: one named row each, where they started. */
export function ChatTaskRows({ chatId, tasks, openId, onOpen, track }: ChatTaskRowsProps) {
  const now = useNow(tasks.some(task => task.state === "running"));
  const { stopping, stop } = useStopTask(chatId);
  return <div className="chat-tasks">
    {tasks.map(task => {
      const key = taskRowKey(task);
      const selected = openId === key;
      const status = taskStatus(task);
      const time = taskElapsed(task, now);
      return <div key={key} ref={track?.(key)} className={`chat-task chat-task--${task.state}`}>
        <button type="button" className="chat-agent chat-task__open" aria-pressed={selected}
          aria-label={`${taskTitle(task)}, ${status}, ${time}`} onClick={() => onOpen(selected ? null : key)}>
          <span className="chat-agent__row">
            <TaskStateIcon task={task} />
            <span className="chat-task__command">{taskTitle(task)}</span>
            <span className="chat-agent__deco">
              <span className="chat-agent__status">{status}</span>
              <span>{time}</span>
            </span>
          </span>
        </button>
        <StopButton task={task} stopping={stopping === task.id} onStop={() => stop(task)} />
      </div>;
    })}
  </div>;
}

interface ChatTaskPeekProps {
  chatId: number;
  task: ChatTask;
  /** The tool call that started it: the command line, and what it streamed (Codex). */
  tool: Extract<ChatItem, { kind: "tool" }> | null;
  onClose: () => void;
}

/** One background command beside the chat: the command, its output, Stop. */
export function ChatTaskPeek({ chatId, task, tool, onClose }: ChatTaskPeekProps) {
  const running = task.state === "running";
  const now = useNow(running);
  const { stopping, stop } = useStopTask(chatId);
  const [file, setFile] = useState<{ output: TaskOutput | null; error: string | null }>({ output: null, error: null });

  // Claude writes the command's output to a file: read its end now, and again
  // while the command runs.
  useEffect(() => {
    const path = task.outputFile;
    if (!path) return;
    let cancelled = false;
    const read = () => void readTaskOutput(path).then(
      output => { if (!cancelled) setFile({ output, error: null }); },
      error => { if (!cancelled) setFile(previous => ({ output: previous.output, error: getErrorMessage(error) })); },
    );
    read();
    const timer = running ? window.setInterval(read, OUTPUT_POLL_MS) : undefined;
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [task.outputFile, running]);

  // Claude's call ends when the command is handed off, so its exit code is the
  // hand-off's; Codex's is the command's, once it ends by itself.
  const output = task.outputFile ? file.output?.text ?? "" : tool?.output ?? "";
  const exitCode = task.outputFile || (task.state !== "completed" && task.state !== "failed") ? undefined : tool?.exitCode;
  const command = tool?.toolKind === "execute" ? tool.title : task.description || task.name;
  const meta = [taskStatus(task), taskElapsed(task, now), task.taskType !== "task" ? task.taskType : null,
    !running && typeof exitCode === "number" ? `exit ${exitCode}` : null].filter(Boolean).join(" · ");

  return <aside className="chat-peek" aria-label={`${taskTitle(task)} background command`} onKeyDown={(event) => {
    // Escape closes the pane here instead of stopping the chat's agent.
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  }}>
    <div className="chat-peek__head">
      <button type="button" className="chat-peek__crumb" onClick={onClose}>Chat</button>
      <ChevronRight size={12} className="chat-peek__sep" aria-hidden="true" />
      <span className="chat-peek__name">{taskName(task)}</span>
      <button type="button" className="icon-btn" aria-label="Close background command" onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    <div className="chat-peek__meta">
      <TaskStateIcon task={task} />
      <span>{meta}</span>
    </div>
    <div className="chat-peek__scroll" aria-label="Command output">
      <div className="chat-peek__label">Command</div>
      <div className="chat-peek__task chat-task__cmd">{command}</div>
      {task.summary && <p className="chat-notice">{task.summary}</p>}
      {task.state === "disconnected" && <p className="chat-notice">The agent stopped without reporting how this ended.</p>}
      <div className="chat-peek__label">Output</div>
      {file.output?.truncated && <p className="chat-notice">Showing the end of the output.</p>}
      {file.error && !output && <p className="chat-notice">{file.error}</p>}
      {output
        ? <pre className="chat-terminal__out chat-task__output">{output}</pre>
        : !file.error && <p className="chat-notice">{running ? "No output yet." : "No output."}</p>}
    </div>
    {running && task.canStop && <div className="chat-peek__foot">
      <StopButton task={task} stopping={stopping === task.id} onStop={() => stop(task)} label="Stop command" />
    </div>}
  </aside>;
}
