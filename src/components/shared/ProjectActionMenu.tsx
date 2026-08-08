import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import tabKindMeta from "../../lib/tabKindMeta";

export type ProjectActionKind = "assistant" | "terminal" | "commands" | "git" | "todos";

interface ProjectActionMenuProps {
  variant: "tab" | "project";
  onAction: (action: ProjectActionKind) => void;
  projectName?: string;
}

const ACTIONS: ProjectActionKind[] = ["assistant", "terminal", "commands", "git", "todos"];

export default function ProjectActionMenu({
  variant,
  onAction,
  projectName,
}: ProjectActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 190;
      const menuHeight = ACTIONS.length * 32 + 8;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
      const below = rect.bottom + 4;
      const top = below + menuHeight <= window.innerHeight
        ? below
        : Math.max(8, rect.top - menuHeight - 4);
      setPosition({ top, left });
    }
    setOpen((value) => !value);
  };

  const label = projectName ? `Add to ${projectName}` : "Add project tab";
  const buttonClass = variant === "tab"
    ? "tab tab-auto !px-3 font-semibold"
    : "section-toggle project-new-tab";

  return (
    <>
      <button
        ref={buttonRef}
        className={buttonClass}
        onClick={handleToggle}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {variant === "tab" ? "+" : (
          <>
            <span className="shrink-0 w-[14px] flex items-center justify-center">
              <Plus size={14} />
            </span>
            <span className="truncate">New Tab</span>
          </>
        )}
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="context-menu"
          style={position}
          role="menu"
          aria-label={label}
        >
          {ACTIONS.map((action) => {
            const meta = tabKindMeta[action];
            return (
              <button
                key={action}
                className="context-menu__item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onAction(action);
                }}
              >
                <span className="context-menu__icon">{meta.icon(14)}</span>
                <span>{meta.label}</span>
                {meta.shortcut && <span className="context-menu__shortcut">{meta.shortcut}</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
