import { memo, useCallback, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, CircleAlert, ShieldAlert, X } from "lucide-react";
import { ChatItemView } from "./ChatItems";
import ChatComposer from "./ChatComposer";
import { ChatProjectPath } from "./chatProjectPath";
import CursorRequestCard from "./CursorRequestCard";
import { useChatStore } from "../../stores/useChatStore";
import { useChatAppearanceStore } from "../../stores/useChatAppearanceStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { answerPermission, cancelChatStartup, cancelTurn } from "../../lib/acp/chatSessions";
import { isStopShortcut } from "../../lib/acp/chatKeys";
import { openUrl } from "../../lib/tauri";
import { pendingRequest, RECENT_TURN_LIMIT, type ChatTurn } from "../../lib/acp/chatModel";
import { splitTurn, turnStopMessage } from "../../lib/acp/chatPresentation";
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
    {error && <p className="chat-error">Couldn’t open your browser. Try the sign-in button again.</p>}
  </>;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const Turn = memo(function Turn({ turn }: { turn: ChatTurn }) {
  const { work, answer } = splitTurn(turn);
  const tools = work.filter((item) => item.kind === "tool");
  const [workExpanded, setWorkExpanded] = useState<boolean | null>(null);
  const showWork = workExpanded ?? tools.some((item) => item.kind === "tool" && item.status === "failed");
  const stopMessage = turnStopMessage(turn);
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
        <details className="chat-worked" open={showWork} onToggle={(event) => setWorkExpanded(event.currentTarget.open)}>
          <summary>
            <ChevronRight size={14} className="chat-worked__chevron" />
            <span>Worked</span>
            <span className="chat-worked__facts">{facts}</span>
          </summary>
          {showWork && <div className="chat-worked__items">
            {work.map((item) => <ChatItemView key={item.id} item={item} streaming={turn.endedAt === null} />)}
          </div>}
        </details>
      )}
      {answer.map((item) => <ChatItemView key={item.id} item={item} streaming={turn.endedAt === null} />)}
      {stopMessage && <div className="chat-notice">{stopMessage}</div>}
    </div>
  );
});

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
  const request = pendingRequest(chat);
  const permission = request?.kind === "permission" ? request : undefined;
  const logo = assistantId ? assistantLogoSrc[assistantId] : undefined;
  const projectName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <ChatProjectPath value={repoPath}>
    <div ref={rootRef} className="chat-view" style={appearanceStyle as CSSProperties}>
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
                  : `${fullAccess ? "Full access: it edits and runs commands without asking." : "It asks before editing or running commands."} Type / for commands.`}
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
          {chat.turns.slice(-visibleTurnCount).map((turn) => <Turn key={turn.id} turn={turn} />)}
          {chat.status === "working" && !request && <div className="chat-working chat-shimmer">Working</div>}
          {chat.error && <div className="chat-error">{chat.error}</div>}
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
        <ChatComposer chatId={chatId} chat={chat} assistantId={assistantId} agentName={agentName} fullAccess={fullAccess} onOpenTerminal={onOpenTerminal} />
      </div>
    </div>
    </ChatProjectPath>
  );
}
