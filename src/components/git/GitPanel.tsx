import { Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, X, PanelLeft, PanelLeftOpen, FileText, Diff } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useGitStore } from "../../stores/useGitStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitPanelStore } from "../../stores/useGitPanelStore";
import {
  gitChangedFiles, gitFileContents, gitFileDiff, gitListFiles,
} from "../../lib/tauri";
import type { ChangedFile } from "../../lib/types";
import FileTree from "./FileTree";
import FileViewer from "./FileViewer";
import ErrorBoundary from "../shared/ErrorBoundary";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import { isMarkdownFile } from "../../lib/markdownRenderer";
import { getCodeViewCSSVariables } from "./codeViewTheme";

const diffViewerLoader = () => import("./DiffViewer");
diffViewerLoader();
const DiffViewer = lazy(diffViewerLoader);

export default function GitPanel() {
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const gitStatus = useGitStore(
    (s) => activeProjectPath ? s.projectGitStatus[activeProjectPath] ?? null : null,
  );

  const panelState = useGitPanelStore((s) =>
    activeProjectPath ? s.perRepo[activeProjectPath] ?? null : null,
  );
  const repoSelectedPath = panelState?.repoSelectedPath ?? null;
  const repoExpanded = panelState?.repoExpanded ?? [];
  const leftSearch = panelState?.leftSearch ?? "";
  const viewerMode = panelState?.viewerMode ?? "file";
  const repoPreferredDiffArea = panelState?.repoPreferredDiffArea ?? {};
  const sidebarCollapsed = panelState?.sidebarCollapsed ?? false;
  const repoScrollPositions = panelState?.repoScrollPositions ?? {};

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [changedFilesLoadedFor, setChangedFilesLoadedFor] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [repoFileContent, setRepoFileContent] = useState<string>("");
  const [repoFileError, setRepoFileError] = useState<string | null>(null);
  const [repoFileLoading, setRepoFileLoading] = useState<boolean>(false);
  const [repoDiffContent, setRepoDiffContent] = useState<string>("");
  const [repoDiffError, setRepoDiffError] = useState<string | null>(null);
  const [repoDiffLoading, setRepoDiffLoading] = useState<boolean>(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const isMarkdown = repoSelectedPath ? isMarkdownFile(repoSelectedPath) : false;

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(() => leftSearch.trim().length > 0);
  const codeViewCSSVariables = getCodeViewCSSVariables();

  const canLoadGitFiles = !!activeProjectPath && !!gitStatus?.is_git_repo;

  const selectedFileChanges = useMemo(
    () => (repoSelectedPath ? files.filter((file) => file.path === repoSelectedPath) : []),
    [files, repoSelectedPath],
  );

  const availableDiffAreas = useMemo(() => {
    const areaPriority = { unstaged: 0, untracked: 1, staged: 2 } as const;
    return Array.from(
      new Set(
        selectedFileChanges
          .map((file) => file.area)
          .filter((area): area is "staged" | "unstaged" | "untracked" =>
            area === "staged" || area === "unstaged" || area === "untracked",
          ),
      ),
    ).sort((a, b) => areaPriority[a] - areaPriority[b]);
  }, [selectedFileChanges]);

  const resolvedDiffArea = useMemo(() => {
    if (!repoSelectedPath || availableDiffAreas.length === 0) return null;
    const preferred = repoPreferredDiffArea[repoSelectedPath];
    return preferred && availableDiffAreas.includes(preferred)
      ? preferred
      : availableDiffAreas[0];
  }, [availableDiffAreas, repoPreferredDiffArea, repoSelectedPath]);

  const hasSelectedDiff = resolvedDiffArea !== null;

  // Fetch changed files for tree highlighting
  const fetchFiles = useCallback(async () => {
    if (!canLoadGitFiles || !activeProjectPath) {
      setFiles([]);
      return;
    }
    const repo = activeProjectPath;
    try {
      const result = await gitChangedFiles(repo);
      setFiles(result);
    } catch {
      setFiles([]);
    } finally {
      setChangedFilesLoadedFor(repo);
    }
  }, [canLoadGitFiles, activeProjectPath]);

  const statusKey = gitStatus
    ? `${gitStatus.staged}:${gitStatus.unstaged}:${gitStatus.untracked}`
    : "";
  useEffect(() => { fetchFiles(); }, [fetchFiles, statusKey]);

  // Fetch repo file list
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath) {
      setRepoFiles([]);
      return;
    }
    const repo = activeProjectPath;
    let cancelled = false;
    void (async () => {
      try {
        const result = await gitListFiles(repo);
        if (!cancelled) setRepoFiles(result);
      } catch (error) {
        if (!cancelled) {
          setRepoFiles([]);
          pushNotice({ tone: "error", title: "Couldn't list repo files", message: getErrorMessage(error) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [canLoadGitFiles, activeProjectPath, pushNotice]);

  // Live-refresh repo file list
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath) return;
    const repo = activeProjectPath;
    const unlistenP = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const result = await gitListFiles(repo);
        setRepoFiles(result);
      } catch {
        // Silent.
      }
    });
    return () => { unlistenP.then((f) => f()); };
  }, [canLoadGitFiles, activeProjectPath]);

  // Fetch file contents when selection changes
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath) {
      setRepoFileContent("");
      setRepoFileError(null);
      setRepoFileLoading(false);
      return;
    }
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    let cancelled = false;
    setRepoFileContent("");
    setRepoFileError(null);
    setRepoFileLoading(true);
    void (async () => {
      try {
        const content = await gitFileContents(repo, path, "working");
        if (!cancelled) setRepoFileContent(content);
      } catch (error) {
        if (!cancelled) setRepoFileError(getErrorMessage(error));
      } finally {
        if (!cancelled) setRepoFileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath]);

  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath || !resolvedDiffArea) {
      setRepoDiffContent("");
      setRepoDiffError(null);
      setRepoDiffLoading(false);
      return;
    }
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    const staged = resolvedDiffArea === "staged";
    let cancelled = false;
    setRepoDiffContent("");
    setRepoDiffError(null);
    setRepoDiffLoading(true);
    void (async () => {
      try {
        const diff = await gitFileDiff(repo, path, staged);
        if (!cancelled) setRepoDiffContent(diff);
      } catch (error) {
        if (!cancelled) setRepoDiffError(getErrorMessage(error));
      } finally {
        if (!cancelled) setRepoDiffLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath, resolvedDiffArea]);

  // Live-refresh open file contents
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath) return;
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    const unlistenP = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const content = await gitFileContents(repo, path, "working");
        setRepoFileContent(content);
        setRepoFileError(null);
      } catch (error) {
        setRepoFileError(getErrorMessage(error));
      }
    });
    return () => { unlistenP.then((f) => f()); };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath]);

  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath || !resolvedDiffArea) return;
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    const staged = resolvedDiffArea === "staged";
    const unlistenP = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const diff = await gitFileDiff(repo, path, staged);
        setRepoDiffContent(diff);
        setRepoDiffError(null);
      } catch (error) {
        setRepoDiffError(getErrorMessage(error));
      }
    });
    return () => { unlistenP.then((f) => f()); };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath, resolvedDiffArea]);

  // Cmd+F focuses the search input while this panel is mounted
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (leftSearch.trim()) setSearchOpen(true);
  }, [leftSearch]);

  useEffect(() => {
    if (!searchOpen) return;
    const id = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [searchOpen]);

  const changedPathsMap = useMemo(() => {
    const m = new Map<string, "added" | "modified">();
    for (const f of files) {
      const kind: "added" | "modified" =
        f.status === "A" || f.status === "?" ? "added" : "modified";
      m.set(f.path, kind);
    }
    return m;
  }, [files]);

  const untrackedPaths = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (f.status === "?") s.add(f.path);
    }
    return s;
  }, [files]);

  // Remove stale selection when the file list refreshes — skip when the list
  // is empty (not yet loaded) to avoid clearing a valid restored selection.
  // Also keep the selection alive when the file is in the changed-files list
  // (e.g. staged deletions disappear from git ls-files but remain in git status).
  useEffect(() => {
    if (!activeProjectPath || !repoSelectedPath || repoFiles.length === 0) return;
    if (repoFiles.includes(repoSelectedPath)) return;
    if (changedPathsMap.has(repoSelectedPath)) return;
    useGitPanelStore.getState().setRepoSelection(activeProjectPath, null);
  }, [activeProjectPath, changedPathsMap, repoFiles, repoSelectedPath]);

  const handleRepoSelect = useCallback(
    (path: string) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setRepoSelection(activeProjectPath, path);
      setRawMarkdown(false);
    },
    [activeProjectPath],
  );

  const handleRepoExpandedChange = useCallback(
    (expanded: string[]) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setRepoExpanded(activeProjectPath, expanded);
    },
    [activeProjectPath],
  );

  const handleSetSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setSidebarCollapsed(activeProjectPath, collapsed);
    },
    [activeProjectPath],
  );

  const handleSetLeftSearch = useCallback(
    (value: string) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setLeftSearch(activeProjectPath, value);
    },
    [activeProjectPath],
  );

  const handleOpenSearch = useCallback(() => setSearchOpen(true), []);

  const handleSetViewerMode = useCallback(
    (mode: "file" | "diff") => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setViewerMode(activeProjectPath, mode);
    },
    [activeProjectPath],
  );

  const handleSetPreferredDiffArea = useCallback(
    (area: "staged" | "unstaged" | "untracked") => {
      if (!activeProjectPath || !repoSelectedPath) return;
      useGitPanelStore.getState().setRepoPreferredDiffArea(activeProjectPath, repoSelectedPath, area);
    },
    [activeProjectPath, repoSelectedPath],
  );

  const handleCloseSearch = useCallback(() => {
    handleSetLeftSearch("");
    setSearchOpen(false);
  }, [handleSetLeftSearch]);

  useEffect(() => {
    // Wait until the changed-files list has actually loaded for this repo.
    // Otherwise hasSelectedDiff is spuriously false on initial mount and the
    // "diff" mode set by an external caller (e.g. toolbar changes summary)
    // gets flipped back to "file".
    if (changedFilesLoadedFor !== activeProjectPath) return;
    if (viewerMode === "diff" && !hasSelectedDiff) {
      handleSetViewerMode("file");
    }
    // Auto-switch to diff when the selected file only exists in the changed
    // list (e.g. staged deletion) — there's no working-tree content to show.
    if (
      viewerMode === "file" &&
      hasSelectedDiff &&
      repoSelectedPath &&
      !repoFiles.includes(repoSelectedPath) &&
      changedPathsMap.has(repoSelectedPath)
    ) {
      handleSetViewerMode("diff");
    }
  }, [activeProjectPath, changedFilesLoadedFor, changedPathsMap, handleSetViewerMode, hasSelectedDiff, repoFiles, repoSelectedPath, viewerMode]);

  if (!activeProjectPath) {
    return (
      <div className="absolute inset-0 flex items-center justify-center opacity-50">
        Select a project to view git status
      </div>
    );
  }

  if (!gitStatus?.is_git_repo) {
    return (
      <div className="absolute inset-0 flex items-center justify-center opacity-50">
        Not a git repository
      </div>
    );
  }

  return (
    <div className="git-panel">
      <div className="git-panel__body">
        {!sidebarCollapsed && (
          <div className="git-panel__sidebar">
            <FileTree
              files={repoFiles}
              changedPaths={changedPathsMap}
              untrackedPaths={untrackedPaths}
              search={leftSearch}
              selectedPath={repoSelectedPath}
              onSelect={handleRepoSelect}
              expandedPaths={repoExpanded}
              onExpandedChange={handleRepoExpandedChange}
            />
          </div>
        )}

        <div
          className={`git-panel__viewer-area${sidebarCollapsed ? " git-panel__viewer-area--wide" : ""}`}
          style={codeViewCSSVariables}
        >
          <div className="git-panel__viewer-controls">
            <div className={`git-panel__header-search-shell${searchOpen ? " git-panel__header-search-shell--open" : ""}`}>
              {searchOpen ? (
                <div className="git-panel__header-search">
                  <Search size={12} className="git-panel__search-icon" />
                  <input
                    ref={searchInputRef}
                    className="git-panel__search-input"
                    type="text"
                    placeholder="Search files…"
                    value={leftSearch}
                    onChange={(e) => handleSetLeftSearch(e.target.value)}
                    onBlur={() => {
                      if (!leftSearch.trim()) setSearchOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        if (leftSearch) handleSetLeftSearch("");
                        else setSearchOpen(false);
                      }
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  {(leftSearch || searchOpen) && (
                    <button
                      className="icon-btn git-panel__search-clear"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (leftSearch) {
                          handleSetLeftSearch("");
                          searchInputRef.current?.focus();
                        } else {
                          handleCloseSearch();
                        }
                      }}
                      title={leftSearch ? "Clear (Esc)" : "Close search"}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  className="git-panel__search-trigger"
                  onClick={handleOpenSearch}
                  title="Search (Cmd/Ctrl+F)"
                  aria-label="Search"
                >
                  <Search size={15} className="git-panel__search-trigger-icon" />
                </button>
              )}
            </div>
            {repoSelectedPath && (
              <div className="git-panel__segmented" role="tablist" aria-label="Viewer mode">
                <button
                  className={`git-panel__segment${viewerMode === "file" ? " git-panel__segment--active" : ""}`}
                  onClick={() => handleSetViewerMode("file")}
                  aria-pressed={viewerMode === "file"}
                  title="Show file contents"
                >
                  <FileText size={13} />
                  <span>File</span>
                </button>
                <button
                  className={`git-panel__segment${viewerMode === "diff" ? " git-panel__segment--active" : ""}`}
                  onClick={() => handleSetViewerMode("diff")}
                  aria-pressed={viewerMode === "diff"}
                  title={hasSelectedDiff ? "Show file diff" : "No diff available"}
                  disabled={!hasSelectedDiff}
                >
                  <Diff size={13} />
                  <span>Diff</span>
                </button>
              </div>
            )}
            {viewerMode === "diff" && availableDiffAreas.length > 1 && (
              <div className="git-panel__segmented" role="tablist" aria-label="Diff area">
                {availableDiffAreas.map((area) => (
                  <button
                    key={area}
                    className={`git-panel__segment${resolvedDiffArea === area ? " git-panel__segment--active" : ""}`}
                    onClick={() => handleSetPreferredDiffArea(area)}
                    aria-pressed={resolvedDiffArea === area}
                    title={area === "staged" ? "Show staged diff" : area === "unstaged" ? "Show working tree diff" : "Show untracked diff"}
                  >
                    <span>{area === "staged" ? "Staged" : area === "unstaged" ? "Working" : "New"}</span>
                  </button>
                ))}
              </div>
            )}
            {viewerMode === "file" && isMarkdown && (
              <button
                className="git-panel__pane-toggle"
                onClick={() => setRawMarkdown((r) => !r)}
                title={rawMarkdown ? "Show rendered" : "Show raw"}
                aria-label={rawMarkdown ? "Show rendered markdown" : "Show raw markdown"}
              >
                <span style={{ fontSize: 11, fontWeight: 500 }}>{rawMarkdown ? "Render" : "Raw"}</span>
              </button>
            )}
            <button
              className="git-panel__pane-toggle"
              onClick={() => handleSetSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Show files panel" : "Hide files panel"}
              aria-label={sidebarCollapsed ? "Show files panel" : "Hide files panel"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeft size={16} />}
            </button>
          </div>

          {repoSelectedPath ? (
            viewerMode === "diff" ? (
              <ErrorBoundary
                resetKey={`${repoSelectedPath}:${resolvedDiffArea ?? "none"}`}
                fallback={(error) => (
                  <div className="git-panel__diff">
                    <div style={{ padding: 24, opacity: 0.55, fontSize: 12 }}>
                      Couldn't render diff for {repoSelectedPath}
                      {import.meta.env.DEV && `: ${error.message}`}
                    </div>
                  </div>
                )}
              >
                <Suspense
                  fallback={(
                    <div className="git-panel__diff">
                      <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>Loading diff viewer…</div>
                    </div>
                  )}
                >
                  <DiffViewer
                    key={`${repoSelectedPath}:${resolvedDiffArea ?? "none"}`}
                    diff={repoDiffContent}
                    filePath={repoSelectedPath}
                    loading={repoDiffLoading}
                    error={repoDiffError}
                  />
                </Suspense>
              </ErrorBoundary>
            ) : (
              <FileViewer
                key={repoSelectedPath}
                contents={repoFileContent}
                filePath={repoSelectedPath}
                loading={repoFileLoading}
                error={repoFileError}
                findTerm={leftSearch}
                rawMarkdown={rawMarkdown}
                initialScrollTop={repoScrollPositions[repoSelectedPath]}
                onScrollChange={(pos) => useGitPanelStore.getState().setRepoScrollPosition(activeProjectPath, repoSelectedPath, pos)}
              />
            )
          ) : (
            <div className="git-panel__diff">
              <div style={{ padding: 24, opacity: 0.35, fontSize: 12 }}>
                Select a file to view
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
