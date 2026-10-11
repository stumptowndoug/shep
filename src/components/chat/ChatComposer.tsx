import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ListPlus, LoaderCircle, Shield, ShieldCheck, Square } from "lucide-react";
import Select from "../shared/Select";
import ChatSettings from "./ChatSettings";
import { useChatDraftStore } from "../../stores/useChatDraftStore";
import type { ChatState } from "../../lib/acp/chatModel";
import { cancelTurn, sendPrompt, setChatOption } from "../../lib/acp/chatSessions";
import { chatOptionChoices, chatOptionName, isAccessOption, isFullAccessMode, isModelOption, isReasoningOption } from "../../lib/acp/chatOptions";

const MAX_COMMAND_SUGGESTIONS = 8;
const MAX_INPUT_HEIGHT = 240;

interface ChatComposerProps {
  chatId: number;
  chat: ChatState;
  agentName: string;
  fullAccess: boolean;
}

function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

export default function ChatComposer({ chatId, chat, agentName, fullAccess }: ChatComposerProps) {
  const draftKey = chat.draftKey ?? `temporary:${chatId}`;
  const text = useChatDraftStore((state) => state.drafts[draftKey] ?? "");
  const setText = (value: string) => useChatDraftStore.getState().setDraft(draftKey, value);
  const [highlight, setHighlight] = useState(0);
  const [changingOption, setChangingOption] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { useChatDraftStore.getState().load(draftKey); }, [draftKey]);
  useEffect(() => { if (inputRef.current) fitHeight(inputRef.current); }, [text, draftKey]);
  const working = chat.status === "working";
  const closed = chat.status === "exited";
  const access = chat.options.find(isAccessOption);
  const options = [chat.options.find(isModelOption), chat.options.find(isReasoningOption), access].filter((option) => option !== undefined);
  const extraOptions = chat.options.filter((option) => !options.some((primary) => primary.id === option.id));
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

  const submit = () => {
    if (!text.trim()) return;
    if (!sendPrompt(chatId, text)) return;
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && working) {
      event.preventDefault();
      cancelTurn(chatId);
    }
  };

  const placeholder = closed
    ? "This session has ended"
    : chat.status === "starting"
      ? `Starting ${agentName}…`
      : working
        ? "Queue a follow-up…"
        : `Ask ${agentName} anything`;

  return (
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
              <span className="popover__item-label chat-composer__command-desc">{command.description}</span>
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
          setHighlight(0);
          fitHeight(event.target);
        }}
        onKeyDown={handleKeyDown}
      />

      <div className="chat-composer__footer">
        <div className="chat-composer__controls">
          {options.map((option) => (
            <Select
              key={option.id}
              value={option.value}
              title={chatOptionName(option)}
              label={isReasoningOption(option) ? "Reasoning" : undefined}
              ariaLabel={`${chatOptionName(option)}: ${chatOptionChoices(option).find((choice) => choice.value === option.value)?.label ?? option.value}`}
              icon={changingOption === option.id ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : isAccessOption(option) ?
                (isFullAccessMode(option.value) ? <ShieldCheck size={14} aria-hidden="true" /> : <Shield size={14} aria-hidden="true" />) : undefined}
              className={isModelOption(option) ? "chat-composer__model" : isAccessOption(option) ? "chat-composer__access" : undefined}
              placement="above"
              choices={chatOptionChoices(option)}
              onChange={(value) => void changeOption(option.id, value)}
              disabled={settingsDisabled}
            />
          ))}
          {!access && <span className="chat-composer__access-status" title={`${fullAccess ? "Shep approves this agent’s permission requests automatically." : "Shep asks you to review this agent’s permission requests."} Start a new chat to change this setting.`}>
            {fullAccess ? <ShieldCheck size={14} aria-hidden="true" /> : <Shield size={14} aria-hidden="true" />}
            {fullAccess ? "Full access" : "Ask first"}
          </span>}
          {chat.usage && (
            <span
              className="chat-composer__usage"
              title={`${chat.usage.used.toLocaleString()} of ${chat.usage.size.toLocaleString()} context tokens`}
            >
              {Math.round((chat.usage.used / chat.usage.size) * 100)}% context
            </span>
          )}
          {chat.queued.length > 0 && (
            <span className="chat-composer__queued">{chat.queued.length} queued</span>
          )}
        </div>
        <div className="chat-composer__actions">
          {extraOptions.length > 0 && <ChatSettings options={extraOptions} disabled={settingsDisabled} onChange={changeOption} />}
          {working && (
            <button type="button" className="chat-composer__send chat-composer__send--stop" onClick={() => cancelTurn(chatId)} title="Stop (Esc)" aria-label="Stop response">
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="chat-composer__send"
            disabled={closed || !text.trim()}
            title={working ? "Queue follow-up (Enter)" : "Send (Enter)"}
            aria-label={working ? "Queue follow-up" : "Send message"}
            onClick={submit}
          >
            {working ? <ListPlus size={15} aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}
