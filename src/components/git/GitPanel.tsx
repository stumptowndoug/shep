import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { useGitStore } from "../../stores/useGitStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitPanelStore, type DiffArea } from "../../stores/useGitPanelStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { gitFileDiff, openFileInEditor, readMarkdownFile } from "../../lib/tauri";
import { useGitChanges } from "../../hooks/useGitChanges";
import { getEditorLabel } from "../../lib/editors";
import { getErrorMessage } from "../../lib/errors";
import { summarizeChanges } from "../../lib/gitChangeSummary";
import ErrorBoundary from "../shared/ErrorBoundary";
import EditorIcon from "../shared/EditorIcon";
import { getCodeViewCSSVariables } from "./codeViewTheme";
// The preview renders with chat's Markdown styles.
import "../chat/chat.css";
import { ChatProjectPath } from "../chat/chatProjectPath";

const DiffViewer = lazy(() => import("./DiffViewer"));
const ChatMarkdown = lazy(() => import("../chat/ChatMarkdown"));

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Merge conflict", "?": "New" };
const AREA_LABEL: Record<DiffArea, string> = { unstaged: "Working", staged: "Staged", untracked: "New" };
const AREA_ORDER: DiffArea[] = ["unstaged", "untracked", "staged"];

/** Changed files in the active project and the diff of the selected one. */
export default function GitPanel() {
  const repo = useTerminalStore((s) => s.activeProjectPath);
  const status = useGitStore((s) => (repo ? s.projectGitStatus[repo] : undefined));
  const selection = useGitPanelStore((s) => (repo ? s.perRepo[repo] : undefined));
  const editorLabel = getEditorLabel(useEditorStore((s) => s.settings.preferredEditor));
  const [diff, setDiff] = useState<{ key: string; text: string; error: string | null } | null>(null);
  // Markdown files can show a rendered preview instead of the diff.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string; error: string | null } | null>(null);
  const isGitRepo = !!status?.is_git_repo;

  const snapshot = useGitChanges(isGitRepo ? repo : null);
  const current = snapshot?.data;
  const summary = useMemo(() => (current ? summarizeChanges(current.files, current.stats) : null), [current]);
  const statsByPath = useMemo(() => new Map((current?.stats ?? []).map((stat) => [stat.path, stat])), [current]);

  // The selected file falls back to the first change, so the panel never opens empty.
  const files = summary?.files ?? [];
  const selectedPath = files.some((file) => file.path === selection?.selectedPath)
    ? selection!.selectedPath!
    : files[0]?.path ?? null;
  const areas = AREA_ORDER.filter((area) =>
    current?.files.some((file) => file.path === selectedPath && file.area === area),
  );
  const preferred = selectedPath ? selection?.preferredArea[selectedPath] : undefined;
  const area: DiffArea | null = preferred && areas.includes(preferred) ? preferred : areas[0] ?? null;
  const diffKey = repo && selectedPath && area ? `${repo}\0${selectedPath}\0${area}` : null;

  // Fetch the selected diff, refreshing with the file list.
  useEffect(() => {
    if (!repo || !selectedPath || !area || !diffKey) return;
    let cancelled = false;
    gitFileDiff(repo, selectedPath, area === "staged")
      .then((text) => { if (!cancelled) setDiff({ key: diffKey, text, error: null }); })
      .catch((error) => { if (!cancelled) setDiff({ key: diffKey, text: "", error: getErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [repo, selectedPath, area, diffKey, current]);

  const selectedFileStatus = summary?.files.find((file) => file.path === selectedPath)?.status;
  const canPreview = !!selectedPath && isMarkdown(selectedPath) && selectedFileStatus !== "D";
  const previewing = canPreview && previewPath === selectedPath;

  // Load the Markdown preview, refreshing with the file list.
  useEffect(() => {
    if (!repo || !previewing || !selectedPath) return;
    let cancelled = false;
    readMarkdownFile(repo, selectedPath)
      .then((text) => { if (!cancelled) setPreview({ path: selectedPath, text: typeof text === "string" ? text : "", error: null }); })
      .catch((error) => { if (!cancelled) setPreview({ path: selectedPath, text: "", error: getErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [repo, previewing, selectedPath, current]);

  if (!repo) return <div className="changes-empty">Select a project to see its changes.</div>;
  if (!isGitRepo) return <div className="changes-empty">This project isn’t a git repository.</div>;

  const openFile = (path: string) => {
    openFileInEditor(repo, path).catch((error) => {
      useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn’t open file", message: getErrorMessage(error) });
    });
  };
  const branch = status.branch && status.branch !== "(detached)" ? status.branch : "Detached HEAD";
  const shownDiff = diff && diff.key === diffKey ? diff : null;
  const selectedFile = files.find((file) => file.path === selectedPath);

  return (
    <div className="changes">
      <aside className="changes__list">
        <header className="changes__header">
          <div className="changes__branch">
            <GitBranch size={14} aria-hidden="true" />
            <span className="changes__branch-name" title={branch}>{branch}</span>
            {(status.ahead > 0 || status.behind > 0) && (
              <span className="changes__sync" title={`${status.ahead} ahead, ${status.behind} behind`}>
                {status.ahead > 0 && `↑${status.ahead}`}{status.ahead > 0 && status.behind > 0 && " "}{status.behind > 0 && `↓${status.behind}`}
              </span>
            )}
          </div>
          {summary && (
            <div className="changes__totals">
              {files.length === 0 ? "No changes" : `${files.length} ${files.length === 1 ? "file" : "files"} changed`}
              {files.length > 0 && <span className="changes__add">+{summary.additions}</span>}
              {files.length > 0 && <span className="changes__del">−{summary.deletions}</span>}
              {current?.statsComplete === false && <span title="Some large files are excluded from line totals">Partial totals</span>}
            </div>
          )}
        </header>

        <ul className="changes__files">
          {files.map((file) => {
            const stat = statsByPath.get(file.path);
            const slash = file.path.lastIndexOf("/");
            const name = file.path.slice(slash + 1);
            const dir = slash >= 0 ? file.path.slice(0, slash) : "";
            const deleted = file.status === "D";
            return (
              <li key={file.path}>
                <div
                  className={`changes__file ${file.path === selectedPath ? "changes__file--on" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={file.path === selectedPath ? "true" : undefined}
                  title={file.path}
                  onClick={() => useGitPanelStore.getState().select(repo, file.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      useGitPanelStore.getState().select(repo, file.path);
                    }
                  }}
                >
                  <span className={`changes__status changes__status--${file.status === "?" ? "new" : file.status.toLowerCase()}`} title={STATUS_LABEL[file.status] ?? file.status}>
                    {file.status === "?" ? "N" : file.status === "U" ? "!" : file.status}
                  </span>
                  <span className="changes__path">
                    <span className="changes__name">{name}</span>
                    {/* Right-to-left so a long folder trims from its start; bdi keeps the slashes in order. */}
                    {dir && <span className="changes__dir"><bdi>{dir}</bdi></span>}
                  </span>
                  {stat && (stat.additions > 0 || stat.deletions > 0) && (
                    <span className="changes__counts">
                      {stat.additions > 0 && <span className="changes__add">+{stat.additions}</span>}
                      {stat.deletions > 0 && <span className="changes__del">−{stat.deletions}</span>}
                    </span>
                  )}
                  {!deleted && (
                    <button
                      type="button"
                      className="icon-btn changes__open"
                      title={editorLabel ? `Open in ${editorLabel}` : "Open in editor"}
                      aria-label={`Open ${file.path} in ${editorLabel ?? "editor"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openFile(file.path);
                      }}
                    >
                      <EditorIcon size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {summary && files.length === 0 && <p className="changes__clean">Working tree is clean.</p>}
      </aside>

      <section className="changes__diff" style={getCodeViewCSSVariables()}>
        {selectedPath && selectedFile ? (
          <>
            <div className="changes__diff-bar">
              <span className="changes__diff-path" title={selectedPath}>{selectedPath}</span>
              {canPreview && (
                <div className="changes__areas" role="group" aria-label="View">
                  <button type="button" className={`changes__area ${!previewing ? "changes__area--on" : ""}`} aria-pressed={!previewing} onClick={() => setPreviewPath(null)}>Diff</button>
                  <button type="button" className={`changes__area ${previewing ? "changes__area--on" : ""}`} aria-pressed={previewing} onClick={() => setPreviewPath(selectedPath)}>Preview</button>
                </div>
              )}
              {!previewing && areas.length > 1 && (
                <div className="changes__areas" role="group" aria-label="Which changes">
                  {areas.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`changes__area ${option === area ? "changes__area--on" : ""}`}
                      aria-pressed={option === area}
                      onClick={() => useGitPanelStore.getState().select(repo, selectedPath, option)}
                    >
                      {AREA_LABEL[option]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedFile.status === "U" && <p className="changes-empty">Merge conflict: the working copy is compared with ours. Resolve the conflict markers in your editor.</p>}
            {previewing ? (
              <div className="changes__preview">
                {preview && preview.path === selectedPath ? (
                  preview.error ? <p className="changes-empty">{preview.error}</p> : (
                    <Suspense fallback={null}>
                      {/* Relative images in a Markdown file are relative to its folder. */}
                      <ChatProjectPath value={`${repo}/${selectedPath.split("/").slice(0, -1).join("/")}`}>
                        <ChatMarkdown text={preview.text} />
                      </ChatProjectPath>
                    </Suspense>
                  )
                ) : <p className="changes-empty">Loading preview…</p>}
              </div>
            ) : <ErrorBoundary
              resetKey={diffKey ?? ""}
              fallback={() => <div className="changes-empty">Couldn’t show the diff for {selectedPath}.</div>}
            >
              <Suspense fallback={<div className="changes-empty">Loading diff…</div>}>
                <DiffViewer
                  key={diffKey ?? ""}
                  diff={shownDiff?.text ?? ""}
                  filePath={selectedPath}
                  loading={!shownDiff}
                  error={shownDiff?.error ?? null}
                />
              </Suspense>
            </ErrorBoundary>}
          </>
        ) : (
          <div className="changes-empty">{snapshot?.error ?? (summary ? "Nothing to review." : "Loading changes…")}</div>
        )}
      </section>
    </div>
  );
}
