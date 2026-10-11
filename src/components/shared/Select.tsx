import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectChoice {
  value: string;
  label: string;
  description?: string;
}

interface SelectProps {
  value: string | null;
  choices: SelectChoice[];
  onChange: (value: string) => void;
  /** Trigger text when nothing (or an unknown value) is selected. */
  placeholder?: string;
  icon?: ReactNode;
  /** Long lists get a filter box. */
  searchThreshold?: number;
  placement?: "above" | "below";
  disabled?: boolean;
  title?: string;
  /** Visible setting name for otherwise ambiguous values such as On or High. */
  label?: string;
  ariaLabel?: string;
  className?: string;
  /** Rendered in the list when there are no choices (e.g. "Loading…"). */
  emptyLabel?: string;
}

/** Compact pill trigger with a popover list; used for model/mode pickers. */
export default function Select({
  value,
  choices,
  onChange,
  placeholder = "Select",
  icon,
  searchThreshold = 12,
  placement = "below",
  disabled = false,
  title,
  label,
  ariaLabel,
  className,
  emptyLabel = "Nothing to choose",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return choices;
    return choices.filter(
      (choice) => choice.label.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle),
    );
  }, [choices, query]);

  const selected = choices.find((choice) => choice.value === value);
  const searchable = choices.length > searchThreshold;

  const toggle = () => {
    if (disabled) return;
    setQuery("");
    setHighlight(Math.max(0, choices.findIndex((choice) => choice.value === value)));
    setOpen((current) => !current);
  };

  const choose = (choice: SelectChoice | undefined) => {
    if (!choice) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (choice.value !== value) onChange(choice.value);
  };

  const moveHighlight = (delta: number) => {
    if (!filtered.length) return;
    const next = (highlight + delta + filtered.length) % filtered.length;
    setHighlight(next);
    listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(filtered[highlight]);
    }
  };

  return (
    <div ref={rootRef} className={`select ${className ?? ""}`} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="select__trigger"
        onClick={toggle}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon}
        {label && <span className="select__label">{label}:</span>}
        <span className="select__value">{selected?.label ?? placeholder}</span>
        <ChevronDown size={13} className="select__chevron" />
      </button>

      {open && (
        <div className={`popover select__popover select__popover--${placement}`} role="listbox">
          {searchable && (
            <input
              autoFocus
              className="popover__search"
              placeholder="Search…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
            />
          )}
          <div ref={listRef} className="popover__list">
            {filtered.map((choice, index) => (
              <button
                key={choice.value}
                type="button"
                role="option"
                aria-selected={choice.value === value}
                className={`popover__item ${index === highlight ? "popover__item--highlight" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(choice)}
              >
                <Check size={13} className={choice.value === value ? "" : "invisible"} />
                <span className="popover__item-label">
                  {choice.label}
                  {choice.description && <span className="select__description">{choice.description}</span>}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <div className="popover__empty">{query ? "No matches" : emptyLabel}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
