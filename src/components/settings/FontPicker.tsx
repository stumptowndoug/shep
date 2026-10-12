import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface FontPickerOption {
  /** Family name, or null for a non-font choice such as "System". */
  value: string | null;
  label: string;
  badge?: string;
  detail?: string;
  /** Render the name in its own font. */
  previewFont?: string;
}

interface FontPickerProps {
  options: FontPickerOption[];
  selected: string | null;
  onSelect: (option: FontPickerOption) => void;
  /** Called when the list opens, e.g. to fetch fonts on first use. */
  onOpen?: () => void;
  loading?: boolean;
}

/** Searchable dropdown of installed font families. */
export default function FontPicker({ options, selected, onSelect, onOpen, loading }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  }, [options, search]);

  const current = options.find((option) => option.value === selected);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          if (!open) {
            setSearch("");
            onOpen?.();
          }
          setOpen(!open);
        }}
        className="option-card option-card--compact justify-between"
        style={{ minWidth: 240 }}
        aria-expanded={open}
      >
        <span className="truncate">{current?.label ?? selected ?? "Select font"}</span>
        <ChevronDown size={14} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="font-picker-dropdown">
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search installed fonts..."
            className="font-picker-search"
          />
          <div className="font-picker-list">
            {filtered.length === 0 && (
              <div className="font-picker-empty">{loading ? "Loading fonts…" : "No matching fonts"}</div>
            )}
            {filtered.map((option) => {
              const active = option.value === selected;
              const style: CSSProperties | undefined = option.previewFont ? { fontFamily: option.previewFont } : undefined;
              return (
                <button
                  key={option.value ?? ""}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelect(option);
                  }}
                  className={`font-picker-item ${active ? "font-picker-item--active" : ""}`}
                >
                  <Check size={14} className={`shrink-0 ${active ? "opacity-100" : "opacity-0"}`} />
                  <span className="font-picker-item__name" style={style}>{option.label}</span>
                  {option.badge && <span className="font-picker-item__badge">{option.badge}</span>}
                  {option.detail && <span className="font-picker-item__count">{option.detail}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
