import { memo, useCallback, useRef } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { ChatItemView } from "./ChatItems";
import ChatComposer from "./ChatComposer";
import { useChatStore } from "../../stores/useChatStore";
import { answerPermission } from "../../lib/acp/chatSessions";
import { lastOf, pendingPermission, type ChatItem, type ChatTurn } from "../../lib/acp/chatModel";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import "./chat.css";

/** Rejections first, the one-time allow last (it's the primary action). */
const APPROVAL_ORDER = ["reject_always", "reject_once", "allow_always", "allow_once"];

/** Distance from the bottom (px) within which new output keeps the view pinned. */
const STICK_THRESHOLD = 48;

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** A finished turn keeps its final answer visible and folds the work above it. */
function splitTurn(turn: ChatTurn): { work: ChatItem[]; answer: ChatItem[] } {
  if (turn.endedAt === null) return { work: [], answer: turn.items };
  const final = lastOf(turn.items);
  const answer = final?.kind === "message" ? [final] : [];
  const work = turn.items.slice(0, turn.items.length - answer.length);
  const notices = work.filter((item) => item.kind === "notice");
  return { work: work.filter((item) => item.kind !== "notice"), answer: [...notices, ...answer] };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const Turn = memo(function Turn({ turn }: { turn: ChatTurn }) {
  const { work, answer } = splitTurn(turn);
  const tools = work.filter((item) => item.kind === "tool");
  const edits = tools.filter((item) => item.kind === "tool" && item.toolKind === "edit").length;
  const facts = [
    formatDuration((turn.endedAt ?? Date.now()) - turn.startedAt),
    tools.length > 0 ? plural(tools.length, "step") : null,
    edits > 0 ? plural(edits, "edit") : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="chat-turn">
      {turn.prompt && <div className="chat-user">{turn.prompt}</div>}
      {work.length > 0 && (
        <details className="chat-worked">
          <summary>
            <ChevronRight size={14} className="chat-worked__chevron" />
            <span>Worked</span>
            <span className="chat-worked__facts">{facts}</span>
          </summary>
          <div className="chat-worked__items">
            {work.map((item) => <ChatItemView key={item.id} item={item} />)}
          </div>
        </details>
      )}
      {answer.map((item) => <ChatItemView key={item.id} item={item} />)}
      {turn.stopReason === "cancelled" && <div className="chat-notice">Stopped</div>}
    </div>
  );
});

interface ChatViewProps {
  chatId: number;
  assistantId: string | null;
  repoPath: string;
  fullAccess: boolean;
}

export default function ChatView({ chatId, assistantId, repoPath, fullAccess }: ChatViewProps) {
  const chat = useChatStore((s) => s.chats[chatId]);
  const assistant = CODING_ASSISTANTS.find((entry) => entry.id === assistantId);
  const agentName = assistant?.name ?? "Agent";
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  // Keep the newest output in view while the user is already at the bottom.
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const scroller = scrollRef.current;
      if (scroller && stuckRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!chat) return null;
  const permission = pendingPermission(chat);
  const logo = assistantId ? assistantLogoSrc[assistantId] : undefined;
  const projectName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <div className="chat-view">
      <div
        ref={scrollRef}
        className="chat-view__scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
        }}
      >
        <div ref={contentRef} className="chat-view__content">
          {chat.turns.length === 0 && chat.status !== "exited" && (
            <div className="chat-empty">
              <div className="chat-empty__eyebrow">
                {logo && <img src={logo} alt="" width={14} height={14} className={getAssistantLogoClass(assistantId!)} />}
                <span>{agentName} · {projectName}</span>
              </div>
              <h1 className="chat-empty__title">New chat.</h1>
              <p className={`chat-empty__lede ${chat.status === "starting" ? "chat-shimmer" : ""}`}>
                {chat.status === "starting"
                  ? `Starting ${agentName}…`
                  : `${fullAccess ? "Full access: it edits and runs commands without asking." : "It asks before editing or running commands."} Type / for commands.`}
              </p>
            </div>
          )}
          {chat.turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
          {chat.status === "working" && !permission && <div className="chat-working chat-shimmer">Working</div>}
          {chat.error && <div className="chat-error">{chat.error}</div>}
        </div>
      </div>

      <div className="chat-view__dock">
        {permission && (
          <div className="chat-approval">
            <div className="chat-approval__head">
              <ShieldAlert size={14} />
              <span className="chat-approval__label">Needs you</span>
            </div>
            <div className="chat-approval__title">{agentName} wants to: {permission.title}</div>
            <div className="chat-approval__actions">
              {[...permission.options]
                .sort((a, b) => APPROVAL_ORDER.indexOf(a.kind) - APPROVAL_ORDER.indexOf(b.kind))
                .map((option) => (
                  <button
                    key={option.optionId}
                    type="button"
                    className={option.kind === "allow_once" ? "btn-primary" : "btn-secondary"}
                    onClick={() => answerPermission(chatId, permission.id, option.optionId)}
                  >
                    {option.name}
                  </button>
                ))}
            </div>
          </div>
        )}
        <ChatComposer chatId={chatId} chat={chat} agentName={agentName} />
      </div>
    </div>
  );
}
