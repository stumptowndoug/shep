import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Settings, Shield, ShieldCheck } from "lucide-react";
import type { ChatOption } from "../../lib/acp/chatModel";
import { chatOptionChoices, chatOptionName } from "../../lib/acp/chatOptions";

interface ChatSettingsProps {
  /** Everything but the model: reasoning, the agent's other settings, access. */
  options: ChatOption[];
  /** Access chosen when the chat started, for agents that can't change it mid-chat. */
  fixedAccess?: "full" | "ask";
  askFirst: boolean;
  busy: boolean;
  disabled: boolean;
  /** The adapter's name and version, from its initialize reply. */
  agentVersion?: string;
  onChange: (id: string, value: string) => Promise<void>;
}

const isToggle = (option: ChatOption) => option.choices.length === 2
  && option.choices.some((choice) => choice.value.toLowerCase() === "on")
  && option.choices.some((choice) => choice.value.toLowerCase() === "off");

/** The gear beside the model: one menu of every other setting, each a group of
 *  names with the current choice ticked. */
export default function ChatSettings({ options, fixedAccess, askFirst, busy, disabled, agentVersion, onChange }: ChatSettingsProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const names = [...options.map(chatOptionName), ...(fixedAccess ? ["Access"] : [])];
  // Open on the current choice of the first setting.
  const focusCurrent = useCallback((popover: HTMLDivElement | null) => {
    (popover?.querySelector<HTMLButtonElement>("[aria-pressed='true']:not(:disabled), button:not(:disabled)"))?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...root.current?.querySelectorAll<HTMLButtonElement>(".chat-settings__popover button:not(:disabled)") ?? []];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={root} className="chat-settings" onKeyDown={handleKeyDown}>
      <button ref={trigger} type="button" className="icon-btn chat-settings__trigger" aria-label="Chat settings"
        title={`Settings: ${names.join(", ")}${askFirst ? " (Ask first)" : ""}`} aria-expanded={open} aria-haspopup="dialog"
        disabled={disabled} onClick={() => setOpen(!open)}>
        {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Settings size={16} aria-hidden="true" />}
        {askFirst && <Shield size={10} className="chat-settings__ask" aria-hidden="true" />}
      </button>
      {open && <div ref={focusCurrent} className="popover chat-settings__popover" role="dialog" aria-label="Chat settings">
        {options.map((option) => {
          const name = chatOptionName(option);
          if (isToggle(option)) {
            const on = option.choices.find((choice) => choice.value.toLowerCase() === "on")!;
            const off = option.choices.find((choice) => choice.value.toLowerCase() === "off")!;
            return (
              <button key={option.id} type="button" role="switch" aria-checked={option.value === on.value}
                className="popover__item chat-settings__toggle" disabled={disabled}
                onClick={() => void onChange(option.id, option.value === on.value ? off.value : on.value)}>
                <span>{name}</span>
                <span className="chat-settings__switch" aria-hidden="true" />
              </button>
            );
          }
          return (
            <div key={option.id} className="chat-settings__group" role="group" aria-label={name}>
              <div className="chat-settings__group-name">{name}</div>
              {chatOptionChoices(option).map((choice) => (
                <button key={choice.value} type="button" className="popover__item" aria-pressed={choice.value === option.value}
                  disabled={disabled} onClick={() => { if (choice.value !== option.value) void onChange(option.id, choice.value); close(); }}>
                  <Check size={13} className={choice.value === option.value ? "" : "invisible"} aria-hidden="true" />
                  <span className="popover__item-label">{choice.label}</span>
                </button>
              ))}
            </div>
          );
        })}
        {fixedAccess && (
          <div className="chat-settings__group" role="group" aria-label="Access">
            <div className="chat-settings__group-name">Access</div>
            <div className="chat-settings__fixed" title={fixedAccess === "full"
              ? "Shep approves this agent’s permission requests automatically."
              : "Shep asks you to review this agent’s permission requests."}>
              {fixedAccess === "full" ? <ShieldCheck size={13} aria-hidden="true" /> : <Shield size={13} aria-hidden="true" />}
              <span>{fixedAccess === "full" ? "Full access" : "Ask first"}</span>
            </div>
            <p className="chat-settings__note">Start a new chat to change this.</p>
          </div>
        )}
        {agentVersion && <p className="chat-settings__note chat-settings__agent">{agentVersion}</p>}
      </div>}
    </div>
  );
}
