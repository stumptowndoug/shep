import { useCallback, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUIStore } from "../../stores/useUIStore";
import { useShallow } from "zustand/shallow";
import { GitBranch } from "lucide-react";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { handleActionKey } from "../../lib/a11y";
import { useGitStore } from "../../stores/useGitStore";
import tabKindMeta, { extraActions } from "../../lib/tabKindMeta";
import type { UnifiedTab } from "../../lib/types";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { agentDisplayLabel } from "../../lib/agentLabels";


function NewSessionButton({ onNewAssistant, onNewShell, onNewCommands, onNewGit, onOpenInEditor }: { onNewAssistant: () => void; onNewShell: () => void; onNewCommands: () => void; onNewGit: () => void; onOpenInEditor: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const menuItems = [
    { key: "assistant", meta: tabKindMeta.assistant, action: onNewAssistant },
    { key: "terminal", meta: tabKindMeta.terminal, action: onNewShell },
    { key: "commands", meta: tabKindMeta.commands, action: onNewCommands },
    { key: "git", meta: tabKindMeta.git, action: onNewGit },
    { key: "editor", meta: extraActions.openInEditor, action: onOpenInEditor },
  ];

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btnRef}
        className="tab tab-auto !px-3 font-semibold"
        onClick={handleToggle}
        title="New session"
        aria-label="Open new session"
      >
        +
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: pos.top, left: pos.left }}
        >
          {menuItems.map(({ key, meta, action }) => (
            <button
              key={key}
              className="context-menu__item"
              onClick={() => { action(); setOpen(false); }}
            >
              <span className="context-menu__icon">{meta.icon(14)}</span>
              <span>{meta.label}</span>
              {meta.shortcut && <span className="context-menu__shortcut">{meta.shortcut}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Render the icon for a tab based on its kind */
function TabIcon({ tab }: { tab: UnifiedTab }) {
  if (tab.kind === "assistant" && tab.assistantId) {
    const logoUrl = assistantLogoSrc[tab.assistantId];
    if (logoUrl) {
      return <img src={logoUrl} alt="" width={12} height={12} className={getAssistantLogoClass(tab.assistantId)} />;
    }
  }
  const meta = tabKindMeta[tab.kind];
  return meta ? <>{meta.icon(12)}</> : null;
}

interface TabBarProps {
  onClose: (tabId: string) => void;
  onNewShell: () => void;
  onNewAssistant: () => void;
  onNewCommands: () => void;
  onNewGit: () => void;
  onOpenInEditor: () => void;
}

export default function TabBar({
  onClose,
  onNewShell,
  onNewAssistant,
  onNewCommands,
  onNewGit,
  onOpenInEditor,
}: TabBarProps) {
  const { activeProjectPath, projectState } = useTerminalStore(
    useShallow((s) => ({ activeProjectPath: s.activeProjectPath, projectState: s.activeProjectPath ? s.projectState[s.activeProjectPath] : null })),
  );
  const projectTerminals = projectState;
  const projectName = activeProjectPath ? activeProjectPath.split("/").pop() : null;
  const agentLabelMode = useProjectSettingsStore((s) => s.settings.agentLabelMode);
  const gitStatus = useGitStore((s) => activeProjectPath ? s.projectGitStatus[activeProjectPath] : null);
  const branch = gitStatus?.branch ?? null;
  const branchIconColor = !gitStatus || !gitStatus.is_git_repo
    ? undefined
    : gitStatus.dirty
      ? "var(--status-attention)"
      : "var(--status-clean)";
  const tabs = projectTerminals?.tabs ?? [];
  const activeTabId = projectTerminals?.activeTabId ?? null;
  const { setActiveTab, reorderTab, updateTab } = useTerminalStore.getState();

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragRef = useRef({ startX: 0, didDrag: false, dropIndex: null as number | null });
  const containerRef = useRef<HTMLDivElement>(null);

  const computeDropIndex = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container) return null;
    const tabEls = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-index]"));
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabEls.length;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, tabId: string) => {
    if ((e.target as HTMLElement).closest(".icon-btn")) return;
    const d = dragRef.current;
    d.startX = e.clientX;
    d.didDrag = false;
    d.dropIndex = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDragTabId(null);
      setDropIndex(null);
      d.didDrag = false;
    };

    const onMove = (ev: PointerEvent) => {
      if (!d.didDrag && Math.abs(ev.clientX - d.startX) > 4) {
        d.didDrag = true;
        setDragTabId(tabId);
      }
      if (d.didDrag) {
        const idx = computeDropIndex(ev.clientX);
        d.dropIndex = idx;
        setDropIndex(idx);
      }
    };

    const onUp = () => {
      if (d.didDrag && d.dropIndex !== null) {
        reorderTab(tabId, d.dropIndex);
      }
      cleanup();
    };

    const onCancel = () => cleanup();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [computeDropIndex, reorderTab]);

  // Only subscribe to global overlay state.
  const { settingsActive, usagePanelActive, portsPanelActive, historyPanelActive } = useUIStore(useShallow((s) => ({
    settingsActive: s.settingsActive,
    usagePanelActive: s.usagePanelActive,
    portsPanelActive: s.portsPanelActive,
    historyPanelActive: s.historyPanelActive,
  })));

  const anyOverlay = settingsActive || usagePanelActive || portsPanelActive || historyPanelActive;

  const handleSelectTab = (tabId: string) => {
    useUIStore.getState().deactivateAllOverlays();
    setActiveTab(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      useTerminalStore.getState().clearTabBell(tab.ptyId);
    }
  };

  const isRenameable = (tab: UnifiedTab) => tab.kind === "terminal" || tab.kind === "assistant";

  return (
    <div className="tab-bar">
      <div
        ref={containerRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Workspace tabs"
      >
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId && !anyOverlay;
          const isDragging = tab.id === dragTabId;
          const displayLabel = tab.kind === "assistant"
            ? agentDisplayLabel(tab, agentLabelMode, projectName ?? undefined)
            : { text: tab.label, isTitle: false };

          const showDropBefore = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === i;
          const showDropAfter = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === i + 1 && i === tabs.length - 1;

          return (
            <div
              key={tab.id}
              data-tab-index={i}
              className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}${showDropBefore ? " drop-before" : ""}${showDropAfter ? " drop-after" : ""}`}
              onClick={() => {
                if (!dragRef.current.didDrag) handleSelectTab(tab.id);
              }}
              onKeyDown={(event) => handleActionKey(event, () => handleSelectTab(tab.id))}
              onPointerDown={(e) => handlePointerDown(e, tab.id)}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              aria-label={`Open tab ${displayLabel.text}`}
            >
              <TabIcon tab={tab} />
              {editingTabId === tab.id ? (
                <input
                  className="tab-rename-input"
                  defaultValue={displayLabel.text}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val && val !== displayLabel.text) updateTab(tab.id, { label: val });
                    setEditingTabId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = displayLabel.text;
                      e.currentTarget.blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span
                    className={`truncate max-w-32${displayLabel.isTitle ? " session-title-output" : ""}`}
                    onDoubleClick={isRenameable(tab) ? (e) => {
                      e.stopPropagation();
                      setEditingTabId(tab.id);
                    } : undefined}
                  >
                    {displayLabel.text}
                  </span>
                </>
              )}
              <button
                className="tab-close"
                aria-label={`Close tab ${displayLabel.text}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}

        <NewSessionButton onNewAssistant={onNewAssistant} onNewShell={onNewShell} onNewCommands={onNewCommands} onNewGit={onNewGit} onOpenInEditor={onOpenInEditor} />
      </div>
      {projectName && (
        <span className="tab-bar__breadcrumb">
          {projectName}
          {branch && (
            <>
              <span className="tab-bar__breadcrumb-on">on</span>
              <GitBranch size={15} className="tab-bar__breadcrumb-icon" style={branchIconColor ? { color: branchIconColor } : undefined} />
              {branch}
            </>
          )}
        </span>
      )}
    </div>
  );
}
