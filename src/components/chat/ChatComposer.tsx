import { useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import Select from "../shared/Select";
import type { ChatState } from "../../lib/acp/chatModel";
import { cancelTurn, sendPrompt, setChatOption } from "../../lib/acp/chatSessions";

const MAX_COMMAND_SUGGESTIONS = 8;
const MAX_INPUT_HEIGHT = 240;

interface ChatComposerProps {
  chatId: number;
  chat: ChatState;
  agentName: string;
}

function fitHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

export default function ChatComposer({ chatId, chat, agentName }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const working = chat.status === "working";
  const closed = chat.status === "exited";

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
    sendPrompt(chatId, text);
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
        onChange={(event) => {
          setText(event.target.value);
          setHighlight(0);
          fitHeight(event.target);
        }}
        onKeyDown={handleKeyDown}
      />

      <div className="chat-composer__footer">
        {chat.options.map((option) => (
          <Select
            key={option.id}
            value={option.value}
            title={option.name}
            placement="above"
            choices={option.choices.map((choice) => ({ value: choice.value, label: choice.name }))}
            onChange={(value) => void setChatOption(chatId, option.id, value)}
            disabled={closed}
          />
        ))}
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
        <div className="flex-1" />
        {working ? (
          <button type="button" className="chat-composer__send chat-composer__send--stop" onClick={() => cancelTurn(chatId)} title="Stop (Esc)">
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="chat-composer__send"
            disabled={closed || !text.trim()}
            title="Send (Enter)"
            onClick={submit}
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
