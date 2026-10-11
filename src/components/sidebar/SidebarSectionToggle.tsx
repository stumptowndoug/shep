import { ChevronRight, Plus } from "lucide-react";

interface SidebarSectionToggleProps {
  label: string;
  collapsed: boolean;
  badge?: number | string | null;
  onToggle: () => void;
  /** Optional "+" that appears on hover, e.g. add project. */
  onAdd?: () => void;
  addLabel?: string;
}

/** Section header: a small uppercase label; chrome appears on hover. */
export default function SidebarSectionToggle({
  label,
  collapsed,
  badge,
  onToggle,
  onAdd,
  addLabel,
}: SidebarSectionToggleProps) {
  return (
    <div className="side-sec__header">
      <button
        className="side-sec__toggle"
        onClick={onToggle}
        title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
        aria-expanded={!collapsed}
      >
        <span className="truncate">{label}</span>
        {badge != null && <span className="side-sec__count">{badge}</span>}
        <ChevronRight size={12} className={`side-sec__chevron ${collapsed ? "" : "side-sec__chevron--open"}`} />
      </button>
      {onAdd && (
        <button className="side-sec__add" onClick={onAdd} title={addLabel} aria-label={addLabel}>
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}
