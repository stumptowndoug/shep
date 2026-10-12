import { useState } from "react";
import { ChartNoAxesCombined, ChevronRight, Ellipsis, History, Plus, Radio, Settings } from "lucide-react";
import { useUIStore } from "../../stores/useUIStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import tabKindMeta from "../../lib/tabKindMeta";
import ProjectOpenMenu, { type ProjectOpenActions } from "../shared/ProjectOpenMenu";

/** New agent is the main action; More opens everything else in the project. */
export function SidebarNewAgent({ hasProject, openActions }: { hasProject: boolean; openActions: ProjectOpenActions }) {
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null);
  const startAgent = () => {
    useUIStore.getState().deactivateAllOverlays();
    useTerminalStore.getState().addPanelTab("launcher");
  };
  const disabledTitle = hasProject ? undefined : "Add a project first";

  return (
    <div className="side-nav side-nav--primary">
      <button
        className="nav-item"
        onClick={hasProject ? startAgent : undefined}
        aria-disabled={!hasProject}
        title={disabledTitle}
      >
        <Plus size={16} />
        <span className="nav-item__label">New agent</span>
        <kbd className="nav-item__kbd">{tabKindMeta.launcher.shortcut}</kbd>
      </button>
      <button
        className="nav-item"
        onClick={hasProject ? (event) => {
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu(menu ? null : { x: rect.right + 6, y: rect.top, anchor });
        } : undefined}
        aria-disabled={!hasProject}
        title={disabledTitle}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
      >
        <Ellipsis size={16} />
        <span className="nav-item__label">More</span>
        <ChevronRight size={13} className="nav-item__chevron" />
      </button>
      {menu && (
        <ProjectOpenMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          actions={openActions}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** App-wide destinations, pinned to the bottom of the sidebar. */
export default function SidebarNav() {
  const settingsActive = useUIStore((s) => s.settingsActive);
  const usageActive = useUIStore((s) => s.usagePanelActive);
  const portsActive = useUIStore((s) => s.portsPanelActive);
  const historyActive = useUIStore((s) => s.historyPanelActive);
  const { toggleSettings, toggleUsagePanel, togglePortsPanel, toggleHistoryPanel } = useUIStore.getState();

  const items = [
    { label: "History", icon: History, on: historyActive, onClick: toggleHistoryPanel },
    { label: "Usage", icon: ChartNoAxesCombined, on: usageActive, onClick: toggleUsagePanel },
    { label: "Ports", icon: Radio, on: portsActive, onClick: togglePortsPanel },
    { label: "Settings", icon: Settings, on: settingsActive, onClick: toggleSettings },
  ];

  return (
    <nav className="side-nav side-nav--footer" aria-label="App navigation">
      {items.map(({ label, icon: Icon, on, onClick }) => (
        <button
          key={label}
          className={`nav-item ${on ? "on" : ""}`}
          onClick={onClick}
          aria-pressed={on}
        >
          <Icon size={16} />
          <span className="nav-item__label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
