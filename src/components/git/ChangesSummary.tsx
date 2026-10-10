import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import { useGitPanelStore } from "../../stores/useGitPanelStore";
import { gitChangedFiles, gitDiffStats } from "../../lib/tauri";
import { summarizeChanges } from "../../lib/gitChangeSummary";
import type { ChangedFile } from "../../lib/types";

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface ChangesData {
  repoPath: string;
  files: ChangedFile[];
  summary: ReturnType<typeof summarizeChanges>;
}

export default function ChangesSummary({ active }: { active: boolean }) {
  const repoPath = useTerminalStore((s) => s.activeProjectPath);
  const isGitRepo = useGitStore((s) => !!repoPath && !!s.projectGitStatus[repoPath]?.is_git_repo);
  const viewerMode = useGitPanelStore((s) => repoPath ? s.perRepo[repoPath]?.viewerMode : undefined);
  const [data, setData] = useState<ChangesData | null>(null);

  useEffect(() => {
    setData(null);
    if (!repoPath || !isGitRepo) return;

    let disposed = false;
    let request = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const currentRequest = ++request;
      try {
        const [files, stats] = await Promise.all([gitChangedFiles(repoPath), gitDiffStats(repoPath)]);
        // Neither another project nor an older refresh may replace current totals.
        if (!disposed && currentRequest === request) {
          setData({ repoPath, files, summary: summarizeChanges(files, stats) });
        }
      } catch {
        // Keep the last successful summary until the next filesystem refresh.
      }
    };
    void refresh();
    const unlisten = listen<{ paths: string[] }>("git-fs-changed", (event) => {
      if (disposed || !event.payload.paths.includes(repoPath)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), 300);
    });
    return () => {
      disposed = true;
      clearTimeout(debounce);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [repoPath, isGitRepo]);

  if (!isGitRepo || !data || data.repoPath !== repoPath || data.summary.files.length === 0) return null;

  const { additions, deletions, files } = data.summary;
  const fileLabel = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
  const openChanges = () => {
    const state = useGitPanelStore.getState();
    const panel = state.perRepo[data.repoPath];
    const selected = files.find((file) => file.path === panel?.repoSelectedPath) ?? files[0];
    const preferredArea = panel?.repoPreferredDiffArea[selected.path];
    const file = data.files.find((file) => file.path === selected.path && file.area === preferredArea) ?? selected;
    if (file.area !== "staged" && file.area !== "unstaged" && file.area !== "untracked") return;
    state.setRepoSelection(data.repoPath, file.path);
    state.setRepoPreferredDiffArea(data.repoPath, file.path, file.area);
    state.setViewerMode(data.repoPath, "diff");
    useTerminalStore.getState().addPanelTab("git");
  };

  return (
    <button
      type="button"
      className="changes-summary"
      title={`${fileLabel}\n${additions.toLocaleString()} additions, ${deletions.toLocaleString()} deletions`}
      aria-label={`Review ${fileLabel}, ${additions} additions and ${deletions} deletions`}
      aria-pressed={active && viewerMode === "diff"}
      onClick={openChanges}
    >
      <span className="changes-summary__add">+{compactNumber.format(additions)}</span>
      <span className="changes-summary__del">−{compactNumber.format(deletions)}</span>
    </button>
  );
}
