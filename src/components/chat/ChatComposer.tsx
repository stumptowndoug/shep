import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowUp, ImagePlus, LoaderCircle, Square, Terminal, X } from "lucide-react";
import Select from "../shared/Select";
import ChatSettings from "./ChatSettings";
import { useChatDraftStore } from "../../stores/useChatDraftStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import type { ChatState, PromptImage } from "../../lib/acp/chatModel";
import { imageFiles, MAX_PROMPT_IMAGES, promptImageFromFile } from "../../lib/acp/promptImages";
import { mentionAt, rankFiles } from "../../lib/acp/fileMentions";
import { loadProjectFiles } from "../../lib/acp/projectFiles";
import { getErrorMessage } from "../../lib/errors";
import { cancelTurn, sendPrompt, setChatOption } from "../../lib/acp/chatSessions";
import { recallStep, sentPrompts } from "../../lib/acp/chatKeys";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { chatOptionChoices, chatOptionName, isAccessOption, isFullAccessMode, isModelOption, isReasoningOption } from "../../lib/acp/chatOptions";

const MAX_COMMAND_SUGGESTIONS = 8;

const MAX_COMMAND_DESCRIPTION = 60;

/** Command and MCP tool descriptions can run for paragraphs; show a short first line. */
function shortDescription(description: string | undefined): string {
  const firstSentence = (description ?? "").trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return firstSentence.length > MAX_COMMAND_DESCRIPTION
    ? `${firstSentence.slice(0, MAX_COMMAND_DESCRIPTION - 1).trimEnd()}…`
    : firstSentence.replace(/[.]$/, "");
}

/** The command word of a message like "/config foo", or null. */
function slashCommandName(text: string): string | null {
  return /^\/([\w:.-]+)(?:\s|$)/.exec(text.trim())?.[1] ?? null;
}
const MAX_INPUT_HEIGHT = 240;

interface ChatComposerProps {
  chatId: number;
  chat: ChatState;
  /** The project, for `@` file mentions. */
  repoPath: string;
  assistantId: string | null;
  agentName: string;
  fullAccess: boolean;
  /** Open this agent's CLI in a new terminal tab, for commands chat can't run. */
  onOpenTerminal?: () => void;
  /** A prompt was sent or queued. */
  onSent?: () => void;
}

/** Where a chat's unsent composer text is kept. */
export function composerDraftKey(chat: ChatState, chatId: number): string {
  return chat.draftKey ?? `temporary:${chatId}`;
}

function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

export default function ChatComposer({ chatId, chat, repoPath, assistantId, agentName, fullAccess, onOpenTerminal, onSent }: ChatComposerProps) {
  const logo = assistantId ? assistantLogoSrc[assistantId] : undefined;
  const draftKey = composerDraftKey(chat, chatId);
  const text = useChatDraftStore((state) => state.drafts[draftKey] ?? "");
  const setText = (value: string) => useChatDraftStore.getState().setDraft(draftKey, value);
  const [highlight, setHighlight] = useState(0);
  const [changingOption, setChangingOption] = useState<string | null>(null);
  // A slash command chat doesn't offer: point to the CLI instead of sending.
  const [cliOnly, setCliOnly] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [dropping, setDropping] = useState(false);
  const hasContent = Boolean(text.trim()) || images.length > 0;
  // `@` file mentions: where the caret is, the project's files, and an Esc-dismissed mention.
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [dismissedMention, setDismissedMention] = useState<number | null>(null);
  // ↑/↓ prompt recall: how far back we are, and the text we put in the box.
  const recallRef = useRef<{ index: number; text: string } | null>(null);
  useEffect(() => { useChatDraftStore.getState().load(draftKey); }, [draftKey]);
  useEffect(() => { if (inputRef.current) fitHeight(inputRef.current); }, [text, draftKey]);
  const working = chat.status === "working";
  const closed = chat.status === "exited";
  // Like Springroll: the model in one button, every other setting behind the gear.
  const model = chat.options.find(isModelOption);
  const reasoning = chat.options.find(isReasoningOption);
  const access = chat.options.find(isAccessOption);
  const settings = [reasoning, ...chat.options.filter((option) => option !== model && option !== reasoning && option !== access), access]
    .filter((option) => option !== undefined);
  const askFirst = access ? !isFullAccessMode(access.value) : !fullAccess;
  const agentLogo = logo && (
    <img src={logo} alt="" width={16} height={16}
      className={["chat-composer__agent", getAssistantLogoClass(assistantId!)].filter(Boolean).join(" ")} />
  );
  const settingsDisabled = closed || chat.status === "starting" || changingOption !== null;

  const changeOption = async (id: string, value: string) => {
    setChangingOption(id);
    try { await setChatOption(chatId, id, value); }
    finally { setChangingOption(null); }
  };

  // Slash commands: only while typing the command word itself.
  const suggestions = useMemo(() => {
    const match = /^\/(\S*)$/.exec(text);
    if (!match) return [];
    const needle = match[1].toLowerCase();
    return chat.commands
      .filter((command) => command.name.toLowerCase().startsWith(needle))
      .slice(0, MAX_COMMAND_SUGGESTIONS);
  }, [chat.commands, text]);

  const addImages = async (files: File[]) => {
    const { pushNotice } = useNoticeStore.getState();
    if (!files.length) return;
    if (!chat.acceptsImages) {
      pushNotice({ tone: "info", title: `${agentName} doesn’t accept images in chat` });
      return;
    }
    const room = MAX_PROMPT_IMAGES - images.length;
    if (files.length > room) pushNotice({ tone: "info", title: `Up to ${MAX_PROMPT_IMAGES} images per message` });
    const results = await Promise.allSettled(files.slice(0, Math.max(0, room)).map(promptImageFromFile));
    const added = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    for (const result of results) {
      if (result.status === "rejected") pushNotice({ tone: "error", title: "Couldn’t attach image", message: getErrorMessage(result.reason) });
    }
    if (added.length) setImages(current => [...current, ...added].slice(0, MAX_PROMPT_IMAGES));
    inputRef.current?.focus();
  };

  const mention = mentionAt(text, caret);
  const activeMention = mention && mention.start !== dismissedMention ? mention : null;
  const mentionQuery = activeMention?.query ?? null;
  const fileSuggestions = useMemo(() => mentionQuery === null ? [] : rankFiles(files, mentionQuery), [files, mentionQuery]);

  // Load the file list when a mention starts, not before: most messages have none.
  const trackCaret = (textarea: HTMLTextAreaElement) => {
    setCaret(textarea.selectionStart);
    const next = mentionAt(textarea.value, textarea.selectionStart);
    if (next && next.start !== mention?.start) {
      loadProjectFiles(repoPath).then(setFiles, (error) => {
        if (import.meta.env.DEV) console.error("Couldn’t list project files:", error);
      });
    }
  };

  const pickFile = (path: string) => {
    if (!activeMention) return;
    const insert = `@${path} `;
    const next = text.slice(0, activeMention.start) + insert + text.slice(caret);
    const at = activeMention.start + insert.length;
    // Render the new value now so the caret lands after the path before the next
    // keystroke; placing it a frame later would move the caret back under typing.
    flushSync(() => {
      setText(next);
      setCaret(at);
      setHighlight(0);
    });
    inputRef.current?.setSelectionRange(at, at);
    inputRef.current?.focus();
  };

  const submit = (force = false) => {
    if (!hasContent) return;
    const command = slashCommandName(text);
    if (!force && command && chat.commands.length > 0 && !chat.commands.some((entry) => entry.name === command)) {
      setCliOnly(command);
      return;
    }
    setCliOnly(null);
    if (!sendPrompt(chatId, text, images)) return;
    recallRef.current = null;
    setText("");
    setImages([]);
    if (inputRef.current) inputRef.current.style.height = "auto";
    onSent?.();
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (fileSuggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + delta + fileSuggestions.length) % fileSuggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pickFile(fileSuggestions[Math.min(highlight, fileSuggestions.length - 1)]);
        return;
      }
      // Esc closes the picker here instead of stopping the agent.
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMention(activeMention!.start);
        return;
      }
    }
    if (suggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pickCommand(suggestions[Math.min(highlight, suggestions.length - 1)].name);
        return;
      }
    }
    // Esc while picking a slash command shouldn't also stop the agent (ChatView handles Esc).
    if (event.key === "Escape" && suggestions.length) {
      event.preventDefault();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      // Like a shell: recall only from an empty box or an unedited recalled prompt.
      const recall = recallRef.current;
      if (text === "" || (recall && text === recall.text)) {
        const step = recallStep(sentPrompts(chat.turns), recall?.index ?? null, event.key === "ArrowUp" ? "older" : "newer");
        if (step) {
          event.preventDefault();
          recallRef.current = step.index === null ? null : { index: step.index, text: step.text };
          setText(step.text);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const placeholder = closed
    ? "This session has ended"
    : chat.status === "starting"
      ? `Starting ${agentName}…`
      : working
        ? "Queue a follow-up · Esc to stop"
        : `Ask ${agentName} anything`;

  return (
    <>
      {cliOnly && (
        <div className="chat-cli-nudge" role="status">
          <Terminal size={14} aria-hidden="true" />
          <span className="chat-cli-nudge__text">
            <strong>/{cliOnly}</strong> isn’t available in chat. Run it in {agentName} in a terminal; it opens as a new session in this project.
          </span>
          {onOpenTerminal && (
            <button type="button" className="btn-primary" onClick={() => {
              setCliOnly(null);
              onOpenTerminal();
            }}>Open terminal</button>
          )}
          <button type="button" className="btn-ghost" onClick={() => submit(true)}>Send anyway</button>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setCliOnly(null)}><X size={13} aria-hidden="true" /></button>
        </div>
      )}
    <div
      className={`chat-composer ${dropping ? "chat-composer--dropping" : ""}`}
      onDragOver={(event) => {
        if (closed || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (closed || !event.dataTransfer.files.length) return;
        event.preventDefault();
        setDropping(false);
        const files = imageFiles(event.dataTransfer.files);
        if (files.length) void addImages(files);
        else useNoticeStore.getState().pushNotice({ tone: "info", title: "Only images can be attached" });
      }}
    >
      {fileSuggestions.length > 0 && (
        <div className="popover chat-composer__commands" role="listbox" aria-label="Files">
          {fileSuggestions.map((path, index) => {
            const slash = path.lastIndexOf("/");
            return (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={`popover__item ${index === highlight ? "popover__item--highlight" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickFile(path);
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="chat-composer__file-name">{path.slice(slash + 1)}</span>
                {slash > 0 && <span className="popover__item-label chat-composer__command-desc">{path.slice(0, slash)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="popover chat-composer__commands" role="listbox">
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`popover__item ${index === highlight ? "popover__item--highlight" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pickCommand(command.name);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <span className="chat-composer__command-name">/{command.name}</span>
              <span className="popover__item-label chat-composer__command-desc" title={command.description || undefined}>
                {shortDescription(command.description)}
              </span>
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className="chat-composer__attachments">
          {images.map((image, index) => {
            const label = image.name ?? `image ${index + 1}`;
            return (
              <div key={index} className="chat-attachment">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={label} />
                <button type="button" className="chat-attachment__remove" aria-label={`Remove ${label}`}
                  onClick={() => setImages(current => current.filter((_, i) => i !== index))}>
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <textarea
        ref={inputRef}
        autoFocus
        rows={1}
        value={text}
        disabled={closed}
        placeholder={placeholder}
        className="chat-composer__input"
        aria-label={`Message ${agentName}`}
        onChange={(event) => {
          setText(event.target.value);
          recallRef.current = null;
          setCliOnly(null);
          setHighlight(0);
          fitHeight(event.target);
          trackCaret(event.target);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          const files = imageFiles(event.clipboardData.files);
          if (!files.length) return;
          // An image alone attaches; text copied along with it still pastes.
          if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
          void addImages(files);
        }}
      />

      <div className="chat-composer__footer">
        <div className="chat-composer__controls">
          {model ? (
            <Select
              value={model.value}
              title={chatOptionName(model)}
              ariaLabel={`${chatOptionName(model)}: ${chatOptionChoices(model).find((choice) => choice.value === model.value)?.label ?? model.value}`}
              icon={changingOption === model.id ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : agentLogo}
              className="chat-composer__model"
              placement="above"
              choices={chatOptionChoices(model)}
              onChange={(value) => void changeOption(model.id, value)}
              disabled={settingsDisabled}
            />
          ) : (
            <span className="chat-composer__agent-name">{agentLogo}{agentName}</span>
          )}
          <ChatSettings
            options={settings}
            fixedAccess={access ? undefined : fullAccess ? "full" : "ask"}
            askFirst={askFirst}
            busy={changingOption !== null && changingOption !== model?.id}
            disabled={settingsDisabled}
            agentVersion={chat.agentVersion}
            onChange={changeOption}
          />
          {chat.acceptsImages && !closed && <>
            <button type="button" className="icon-btn chat-composer__attach" aria-label="Attach images" title="Attach images (or paste / drop them)"
              onClick={() => fileInputRef.current?.click()}>
              <ImagePlus size={16} aria-hidden="true" />
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
              void addImages(imageFiles(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }} />
          </>}
        </div>
        <div className="chat-composer__actions">
          {chat.queued.length > 0 && (
            <span className="chat-composer__queued" role="status">{chat.queued.length} queued</span>
          )}
          {chat.usage && (
            <span
              className="chat-composer__usage"
              title={`${chat.usage.used.toLocaleString()} of ${chat.usage.size.toLocaleString()} context tokens`}
            >
              {Math.round((chat.usage.used / chat.usage.size) * 100)}% context
            </span>
          )}
          {working && (
            <button type="button" className="chat-composer__send chat-composer__send--stop" onClick={() => cancelTurn(chatId)} title="Stop (Esc or ⌃C)" aria-label="Stop response">
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          )}
          {/* Mid-turn, Stop stands alone until there's a follow-up to queue. */}
          {!(working && !hasContent) && (
            <button
              type="button"
              className="chat-composer__send"
              disabled={closed || !hasContent}
              title={working ? "Queue follow-up (Enter)" : "Send (Enter)"}
              aria-label={working ? "Queue follow-up" : "Send message"}
              onClick={() => submit()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
