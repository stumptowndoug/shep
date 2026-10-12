import { useEffect, useRef, useState, useCallback, forwardRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  keepOpen?: boolean;
  separator?: boolean;
  /** Keyboard shortcut shown at the trailing edge, e.g. ⌘T. */
  shortcut?: string;
  onClick?: () => void;
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Accessible name for the menu. */
  label?: string;
  /** The button that toggles this menu; clicks on it are left to the button. */
  anchor?: HTMLElement | null;
}

export default function ContextMenu({ x, y, items, onClose, label = "Context menu", anchor }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [previousFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusMenu = useCallback((element: HTMLDivElement | null) => {
    menuRef.current = element;
    if (!element) return;
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
    };
  }, [previousFocus]);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        // Don't close if clicking inside a portaled submenu
        const target = e.target as HTMLElement;
        if (target.closest?.(".context-menu--submenu")) return;
        if (anchor?.contains(target)) return;
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchor]);

  return (
    <div
      ref={focusMenu}
      className="context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        }
      }}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={`sep-${index}`} className="context-menu__separator" />;
        }
        if (item.children && item.children.length > 0) {
          return (
            <SubmenuItem
              key={item.label}
              item={item}
              autoFocus={index === 0}
              onClose={onClose}
            />
          );
        }
        return (
          <button
            key={item.label}
            className={`context-menu__item ${item.danger ? "context-menu__item--danger" : ""}`}
            role="menuitem"
            autoFocus={index === 0}
            onClick={() => {
              item.onClick?.();
              if (!item.keepOpen) onClose();
            }}
          >
            {item.icon && <span className="context-menu__icon">{item.icon}</span>}
            <span>{item.label}</span>
            {item.shortcut && <kbd className="context-menu__shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

// ── Submenu item (Single Responsibility: manages its own hover + position) ──

interface SubmenuItemProps {
  item: ContextMenuItem;
  autoFocus: boolean;
  onClose: () => void;
}

function SubmenuItem({ item, autoFocus, onClose }: SubmenuItemProps) {
  const [open, setOpen] = useState(false);
  const itemRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleEnter = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpen(true), 80);
  }, []);

  const handleLeave = useCallback((e: React.MouseEvent) => {
    const related = e.relatedTarget as Node | null;
    if (
      submenuRef.current?.contains(related) ||
      itemRef.current?.contains(related)
    ) {
      return;
    }
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpen(false), 120);
  }, []);

  useEffect(() => {
    return () => clearTimeout(hoverTimerRef.current);
  }, []);

  // Calculate submenu position relative to the trigger item
  const getSubmenuPosition = useCallback(() => {
    const el = itemRef.current;
    if (!el) return { left: 0, top: 0 };
    const rect = el.getBoundingClientRect();
    let left = rect.right + 2;
    let top = rect.top;

    // Estimate submenu size (will be refined in useEffect on the submenu)
    const estimatedWidth = 180;
    const estimatedHeight = (item.children?.length ?? 0) * 32;

    // Flip left if overflows right edge
    if (left + estimatedWidth > window.innerWidth) {
      left = rect.left - estimatedWidth - 2;
    }
    // Shift up if overflows bottom
    if (top + estimatedHeight > window.innerHeight) {
      top = Math.max(8, window.innerHeight - estimatedHeight - 8);
    }
    return { left, top };
  }, [item.children?.length]);

  return (
    <>
      <button
        ref={itemRef}
        className="context-menu__item"
        role="menuitem"
        autoFocus={autoFocus}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onClick={() => setOpen((v) => !v)}
      >
        {item.icon && <span className="context-menu__icon">{item.icon}</span>}
        <span>{item.label}</span>
        <span className="context-menu__chevron">
          <ChevronRight size={12} />
        </span>
      </button>
      {open &&
        item.children &&
        createPortal(
          <SubmenuPanel
            ref={submenuRef}
            items={item.children}
            position={getSubmenuPosition()}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
            onClose={onClose}
          />,
          document.body,
        )}
    </>
  );
}

// ── Submenu panel (SRP: renders + positions the child menu) ──

interface SubmenuPanelProps {
  items: ContextMenuItem[];
  position: { left: number; top: number };
  onMouseEnter: () => void;
  onMouseLeave: (e: React.MouseEvent) => void;
  onClose: () => void;
}

const SubmenuPanel = forwardRef<HTMLDivElement, SubmenuPanelProps>(
  function SubmenuPanel({ items, position, onMouseEnter, onMouseLeave, onClose }, ref) {
    const innerRef = useRef<HTMLDivElement>(null);

    // Refine position after mount if the actual size overflows
    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        el.style.left = `${position.left - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        el.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
      }
    }, [position]);

    // Merge refs
    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      },
      [ref],
    );

    return (
      <div
        ref={setRefs}
        className="context-menu context-menu--submenu"
        style={{ left: position.left, top: position.top }}
        role="menu"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {items.map((child, i) => {
          if (child.separator) {
            return <div key={`sep-${i}`} className="context-menu__separator" />;
          }
          return (
            <button
              key={child.label}
              className={`context-menu__item ${child.danger ? "context-menu__item--danger" : ""}`}
              role="menuitem"
              autoFocus={i === 0}
              onClick={() => {
                child.onClick?.();
                if (!child.keepOpen) onClose();
              }}
            >
              {child.icon && <span className="context-menu__icon">{child.icon}</span>}
              <span>{child.label}</span>
            </button>
          );
        })}
      </div>
    );
  },
);
