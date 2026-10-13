import { Fragment, useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, CircleAlert, ShieldAlert, X } from "lucide-react";
import ChatComposer from "./ChatComposer";
import { ChatErrorNotice } from "./ChatItems";
import { PromptImages, Turn } from "./ChatTurn";
import { ChatAgentGroup } from "./ChatWorkers";
import ChatWorkerPeek from "./ChatWorkerPeek";
import { ChatProjectPath } from "./chatProjectPath";
import CursorRequestCard from "./CursorRequestCard";
import { useChatStore } from "../../stores/useChatStore";
import { useChatAppearanceStore } from "../../stores/useChatAppearanceStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { answerPermission, cancelChatStartup, cancelTurn } from "../../lib/acp/chatSessions";
import { isStopShortcut } from "../../lib/acp/chatKeys";
import { openUrl } from "../../lib/tauri";
import { pendingRequest, RECENT_TURN_LIMIT } from "../../lib/acp/chatModel";
import { waitingWorkerIds, type ChatWorker } from "../../lib/acp/chatWorkers";
import { chatAppearanceStyle } from "../../lib/chatAppearance";
import { buildCSSFontFamily } from "../../lib/terminalConfig";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import "./chat.css";

/** Rejections first, the one-time allow last (it's the primary action). */
const APPROVAL_ORDER = ["reject_always", "reject_once", "allow_always", "allow_once"];

/** Distance from the bottom (px) within which new output keeps the view pinned. */
const STICK_THRESHOLD = 48;
const TURN_PAGE_SIZE = RECENT_TURN_LIMIT;
const NO_WORKERS: ChatWorker[] = [];
const NO_WAITING: ReadonlySet<string> = new Set();

function ChatSignIn({ chatId, url }: { chatId: number; url?: string }) {
  const [error, setError] = useState(false);
  return <>
    <div className="chat-sign-in">
      {url && <button type="button" className="btn-primary" onClick={() => {
        setError(false);
        void openUrl(url).catch(() => setError(true));
      }}>Sign in with Google <ChevronRight size={14} /></button>}
      <button type="button" className="btn-secondary" onClick={() => cancelChatStartup(chatId)}>Cancel</button>
    </div>
    {url && <p className="field-note">Finish signing in in your browser. This chat will connect automatically.</p>}
    {error && <ChatErrorNotice text="Couldn’t open your browser. Try the sign-in button again." />}
  </>;
}

function PendingMessage({ text, unsent = false }: { text: string; unsent?: boolean }) {
  return <div className="chat-pending" role="group" aria-label={unsent ? "Not sent message" : "Queued message"}>
    <span className="chat-pending__label" title={unsent ? "This message was not sent to the agent." : "Will be sent when the current turn finishes."}>
      {unsent ? "Not sent" : "Queued"}
    </span>
    <div className="chat-user">{text}</div>
  </div>;
}

interface ChatViewProps {
  chatId: number;
  assistantId: string | null;
  repoPath: string;
  fullAccess: boolean;
  /** Open this agent's CLI in a new terminal tab. */
  onOpenTerminal?: () => void;
}

export default function ChatView({ chatId, assistantId, repoPath, fullAccess, onOpenTerminal }: ChatViewProps) {
  const chat = useChatStore((s) => s.chats[chatId]);
  const appearance = useChatAppearanceStore((s) => s.appearance);
  const codeFont = useTerminalSettingsStore((s) => s.settings.fontFamily);
  const assistant = CODING_ASSISTANTS.find((entry) => entry.id === assistantId);
  const agentName = assistant?.name ?? "Agent";
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [visibleTurnCount, setVisibleTurnCount] = useState(TURN_PAGE_SIZE);
  const [openWorkerId, setOpenWorkerId] = useState<string | null>(null);
  const workers = chat?.workers ?? NO_WORKERS;
  // Group by the turn that started them. Workers from before any turn (a
  // resumed session's replay) have nowhere to sit, so they follow the turns.
  const workersByTurn = useMemo(() => {
    const groups = new Map<number | undefined, ChatWorker[]>();
    for (const worker of workers) groups.set(worker.turnId, [...(groups.get(worker.turnId) ?? []), worker]);
    return groups;
  }, [workers]);
  // A string key keeps the set stable while unrelated chat updates stream in.
  const waitingKey = chat ? waitingWorkerIds(chat).join("\n") : "";
  const waiting = useMemo(() => waitingKey ? new Set(waitingKey.split("\n")) : NO_WAITING, [waitingKey]);

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

  // Esc or Ctrl+C stops the agent from anywhere in this chat, or when nothing
  // has focus. Hidden chats (other tabs, overlays) and other focused UI are left alone.
  const rootRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isStopShortcut(event)) return;
      if (useChatStore.getState().chats[chatId]?.status !== "working") return;
      if (node.getClientRects().length === 0) return;
      const target = event.target;
      const unfocused = target === document.body || target === document.documentElement;
      if (!unfocused && !(target instanceof Node && node.contains(target))) return;
      event.preventDefault();
      cancelTurn(chatId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatId]);

  if (!chat) return null;
  const appearanceStyle = chatAppearanceStyle(appearance, buildCSSFontFamily(codeFont));
  const notices = chat.notices ?? [];
  // Live chats can survive a development reload from before this field existed.
  const unsentPrompts = chat.unsentPrompts ?? [];
  const request = pendingRequest(chat);
  const permission = request?.kind === "permission" ? request : undefined;
  const logo = assistantId ? assistantLogoSrc[assistantId] : undefined;
  const projectName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;
  const orphans = workers.filter(worker => worker.turnId === undefined || !chat.turns.some(turn => turn.id === worker.turnId));
  const openWorker = workers.find(worker => worker.sessionId === openWorkerId);

  return (
    <ChatProjectPath value={repoPath}>
    <div ref={rootRef} className="chat-view" style={appearanceStyle as CSSProperties}>
      <div className="chat-view__main">
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
                <p role={chat.status === "starting" ? "status" : undefined} className={`chat-empty__lede ${chat.status === "starting" && !chat.startup?.authUrl ? "chat-shimmer" : ""}`}>
                  {chat.status === "starting"
                    ? chat.startup?.message ?? `Starting ${agentName}…`
                    : `${fullAccess ? "Full access: it edits and runs commands without asking." : "It asks before editing or running commands."} Type / for commands, @ for files.`}
                </p>
                {chat.status === "starting" && chat.startup && <ChatSignIn chatId={chatId} url={chat.startup.authUrl} />}
              </div>
            )}
            {chat.turns.length > visibleTurnCount && <button type="button" className="btn-secondary" onClick={() => {
              stuckRef.current = false;
              setVisibleTurnCount(count => count + TURN_PAGE_SIZE);
            }}>Show {Math.min(TURN_PAGE_SIZE, chat.turns.length - visibleTurnCount)} earlier turns</button>}
            {visibleTurnCount > TURN_PAGE_SIZE && <button type="button" className="btn-secondary" onClick={() => {
              stuckRef.current = true;
              setVisibleTurnCount(TURN_PAGE_SIZE);
            }}>Show recent turns</button>}
            {unsentPrompts.filter(prompt => prompt.afterTurnId === null).map((prompt, index) => <PendingMessage key={index} text={prompt.text} unsent />)}
            {chat.turns.slice(-visibleTurnCount).map((turn) => <Fragment key={turn.id}>
              <Turn turn={turn} {...(workersByTurn.has(turn.id) ? { workers: workersByTurn.get(turn.id), waiting, openWorkerId, onOpenWorker: setOpenWorkerId } : {})} />
              {unsentPrompts.filter(prompt => prompt.afterTurnId === turn.id).map((prompt, index) => <PendingMessage key={index} text={prompt.text} unsent />)}
            </Fragment>)}
            {orphans.length > 0 && <ChatAgentGroup workers={orphans} waiting={waiting} openId={openWorkerId} onOpen={setOpenWorkerId} />}
            {chat.status === "working" && !request && <div className="chat-working chat-shimmer">Working</div>}
            {chat.error && <ChatErrorNotice text={chat.error} />}
            {(chat.queuedImages?.length ?? 0) > 0 && <div className="chat-pending" role="group" aria-label="Queued images">
              <span className="chat-pending__label">Queued</span>
              <PromptImages images={chat.queuedImages} />
            </div>}
            {chat.queued.map((text, index) => <PendingMessage key={index} text={text} />)}
          </div>
        </div>

        <div className="chat-view__dock">
          {notices.length > 0 && <div className="chat-session-notices" role="status">
            {notices.map((notice) => (
              <div key={notice.id} className={`chat-session-notice ${notice.severity === "error" ? "chat-session-notice--error" : ""}`}>
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>{notice.title}</strong>{notice.description && <> · {notice.description}</>}</span>
                <button type="button" className="icon-btn" aria-label={`Dismiss ${notice.title}`} onClick={() => {
                  useChatStore.getState().update(chatId, (state) => ({ ...state, notices: (state.notices ?? []).filter((item) => item.id !== notice.id) }));
                }}><X size={13} aria-hidden="true" /></button>
              </div>
            ))}
          </div>}
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
          {request?.kind === "cursor_request" && <CursorRequestCard key={request.id} chatId={chatId} item={request} />}
          <ChatComposer chatId={chatId} chat={chat} repoPath={repoPath} assistantId={assistantId} agentName={agentName} fullAccess={fullAccess} onOpenTerminal={onOpenTerminal} />
        </div>
      </div>
      {openWorker && <ChatWorkerPeek
        key={openWorker.sessionId}
        worker={openWorker}
        startedBy={workers.find(worker => worker.sessionId === openWorker.parentSessionId)?.name ?? agentName}
        waiting={waiting.has(openWorker.sessionId)}
        onClose={() => setOpenWorkerId(null)}
      />}
    </div>
    </ChatProjectPath>
  );
}
