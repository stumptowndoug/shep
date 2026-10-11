import { ChartNoAxesCombined, History, Radio, Settings } from "lucide-react";
import { useUIStore } from "../../stores/useUIStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import tabKindMeta from "../../lib/tabKindMeta";

/** Opens the project's launcher: agents first, plus terminal, commands, files, to-dos. */
export function SidebarNewAgent({ hasProject }: { hasProject: boolean }) {
  const startAgent = () => {
    useUIStore.getState().deactivateAllOverlays();
    useTerminalStore.getState().addPanelTab("launcher");
  };

  return (
    <div className="side-nav side-nav--primary">
      <button
        className="nav-item"
        onClick={hasProject ? startAgent : undefined}
        aria-disabled={!hasProject}
        title={hasProject ? undefined : "Add a project first"}
      >
        {tabKindMeta.launcher.icon(16)}
        <span className="nav-item__label">New tab</span>
        <kbd className="nav-item__kbd">{tabKindMeta.launcher.shortcut}</kbd>
      </button>
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
