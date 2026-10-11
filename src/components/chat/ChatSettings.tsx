import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Settings, X } from "lucide-react";
import type { ChatOption } from "../../lib/acp/chatModel";
import { chatOptionChoices, chatOptionName } from "../../lib/acp/chatOptions";

interface ChatSettingsProps {
  options: ChatOption[];
  disabled: boolean;
  onChange: (id: string, value: string) => Promise<void>;
}

export default function ChatSettings({ options, disabled, onChange }: ChatSettingsProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.id === selectedId);
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>(".chat-settings__popover button")?.focus();
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  return (
    <div ref={root} className="chat-settings" onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <button ref={trigger} type="button" className="icon-btn chat-settings__trigger" aria-label="Chat settings"
        title="More chat settings" aria-expanded={open} aria-haspopup="dialog" disabled={disabled}
        onClick={() => { setSelectedId(null); setOpen(!open); }}>
        <Settings size={16} aria-hidden="true" />
      </button>
      {open && <div className="popover chat-settings__popover" role="dialog" aria-label="Chat settings">
        <div className="chat-settings__heading">
          {selected && <button type="button" className="icon-btn" aria-label="Back to chat settings" onClick={() => setSelectedId(null)}><ChevronLeft size={14} aria-hidden="true" /></button>}
          <span>{selected ? chatOptionName(selected) : "Chat settings"}</span>
          <button type="button" className="icon-btn" aria-label="Close chat settings" onClick={close}><X size={14} aria-hidden="true" /></button>
        </div>
        <div className="popover__list">
          {selected ? chatOptionChoices(selected).map((choice) => (
            <button key={choice.value} type="button" className="popover__item" aria-pressed={choice.value === selected.value}
              disabled={disabled} onClick={() => { if (choice.value !== selected.value) void onChange(selected.id, choice.value); close(); }}>
              <Check size={13} className={choice.value === selected.value ? "" : "invisible"} aria-hidden="true" />
              <span className="popover__item-label">{choice.label}</span>
            </button>
          )) : options.map((option) => {
            const on = option.choices.find((choice) => choice.value.toLowerCase() === "on");
            const off = option.choices.find((choice) => choice.value.toLowerCase() === "off");
            if (option.choices.length === 2 && on && off) return (
              <button key={option.id} type="button" role="switch" aria-checked={option.value === on.value}
                className="popover__item chat-settings__toggle" disabled={disabled}
                onClick={() => void onChange(option.id, option.value === on.value ? off.value : on.value)}>
                <span>{chatOptionName(option)}</span>
                <span className="chat-settings__switch" aria-hidden="true" />
              </button>
            );
            return (
              <button key={option.id} type="button" className="popover__item chat-settings__row" disabled={disabled}
                onClick={() => setSelectedId(option.id)}>
                <span>{chatOptionName(option)}</span>
                <span className="chat-settings__value">{chatOptionChoices(option).find((choice) => choice.value === option.value)?.label ?? option.value}</span>
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>}
    </div>
  );
}
