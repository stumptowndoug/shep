import { ChartNoAxesCombined, History, Radio } from "lucide-react";
import { useUIStore } from "../../stores/useUIStore";
import GearIcon from "./icons/GearIcon";

export default function SidebarFooter() {
  const settingsActive = useUIStore((s) => s.settingsActive);
  const usageActive = useUIStore((s) => s.usagePanelActive);
  const portsActive = useUIStore((s) => s.portsPanelActive);
  const historyActive = useUIStore((s) => s.historyPanelActive);
  const { toggleSettings, toggleUsagePanel, togglePortsPanel, toggleHistoryPanel } = useUIStore.getState();
  const base = "sidebar-footer-btn";

  return (
    <div className="border-t border-[var(--glass-border)] px-2 pt-2 pb-1.5">
      <div className="flex items-stretch gap-1">
        <button
          onClick={toggleSettings}
          className={`${base} ${settingsActive ? "active" : ""}`}
          aria-label="Open settings"
        >
          <GearIcon size={20} />
          <span className="text-[10px]">Settings</span>
        </button>
        <button
          onClick={toggleHistoryPanel}
          className={`${base} ${historyActive ? "active" : ""}`}
          aria-label="Open session history"
        >
          <History size={18} />
          <span className="text-[10px]">History</span>
        </button>
        <button
          onClick={toggleUsagePanel}
          className={`${base} ${usageActive ? "active" : ""}`}
          aria-label="Open usage"
        >
          <ChartNoAxesCombined size={18} />
          <span className="text-[10px]">Usage</span>
        </button>
        <button
          onClick={togglePortsPanel}
          className={`${base} ${portsActive ? "active" : ""}`}
          aria-label="Open ports"
        >
          <Radio size={18} />
          <span className="text-[10px]">Ports</span>
        </button>
      </div>
    </div>
  );
}
