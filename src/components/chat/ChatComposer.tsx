import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Square, Terminal, X } from "lucide-react";
import Select from "../shared/Select";
import ChatSettings from "./ChatSettings";
import { useChatDraftStore } from "../../stores/useChatDraftStore";
import type { ChatState } from "../../lib/acp/chatModel";
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
  assistantId: string | null;
  agentName: string;
  fullAccess: boolean;
  /** Open this agent's CLI in a new terminal tab, for commands chat can't run. */
  onOpenTerminal?: () => void;
}

function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

export default function ChatComposer({ chatId, chat, assistantId, agentName, fullAccess, onOpenTerminal }: ChatComposerProps) {
  const logo = assistantId ? assistantLogoSrc[assistantId] : undefined;
  const draftKey = chat.draftKey ?? `temporary:${chatId}`;
  const text = useChatDraftStore((state) => state.drafts[draftKey] ?? "");
  const setText = (value: string) => useChatDraftStore.getState().setDraft(draftKey, value);
  const [highlight, setHighlight] = useState(0);
  const [changingOption, setChangingOption] = useState<string | null>(null);
  // A slash command chat doesn't offer: point to the CLI instead of sending.
  const [cliOnly, setCliOnly] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  const submit = (force = false) => {
    if (!text.trim()) return;
    const command = slashCommandName(text);
    if (!force && command && chat.commands.length > 0 && !chat.commands.some((entry) => entry.name === command)) {
      setCliOnly(command);
      return;
    }
    setCliOnly(null);
    if (!sendPrompt(chatId, text)) return;
    recallRef.current = null;
    setText("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
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
    <div className="chat-composer">
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
        }}
        onKeyDown={handleKeyDown}
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
            onChange={changeOption}
          />
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
          {!(working && !text.trim()) && (
            <button
              type="button"
              className="chat-composer__send"
              disabled={closed || !text.trim()}
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
