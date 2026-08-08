import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  RepoGroup,
  RegisteredRepo,
  WorkspaceConfig,
  PtyColorTheme,
  PtyOutput,
  ProjectSettings,
  GitStatus,
  ChangedFile,
  WorktreeEntry,
  CreatedWorktree,
  EditorSettings,
  KeybindingSettings,
  TerminalSettings,
  FontFamily,
  FontFaceData,
  PreferredEditor,
  ProviderUsageSnapshot,
  LocalUsageDetails,
  UsageSettings,
  UsageOverview,
  UsageProjectAliasReviewItem,
  PortInfo,
  PiConfig,
  PiSettings,
  DiffFileStat,
  TodoFile,
  SkillInfo,
  SessionHistoryEntry,
  SessionHistoryUpsert,
  AgentRuntimeStatus,
} from "./types";

// ── Workspace commands ──────────────────────────────────────────────

export function listRepos(): Promise<RepoInfo[]> {
  return invoke("list_repos");
}

export function registerRepo(repoPath: string): Promise<RegisteredRepo> {
  return invoke("register_repo", { repoPath });
}

export function unregisterRepo(repoPath: string): Promise<void> {
  return invoke("unregister_repo", { repoPath });
}

// ── Group commands ────────────────────────────────────────────────

export function listGroups(): Promise<RepoGroup[]> {
  return invoke("list_groups");
}

export function createGroup(name: string): Promise<RepoGroup> {
  return invoke("create_group", { name });
}

export function renameGroup(groupId: string, newName: string): Promise<void> {
  return invoke("rename_group", { groupId, newName });
}

export function deleteGroup(groupId: string): Promise<void> {
  return invoke("delete_group", { groupId });
}

export function moveRepoToGroup(repoPath: string, groupId: string | null): Promise<void> {
  return invoke("move_repo_to_group", { repoPath, groupId });
}

export function loadWorkspace(repoPath: string): Promise<WorkspaceConfig> {
  return invoke("load_workspace", { repoPath });
}

export function saveWorkspace(
  repoPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  return invoke("save_workspace", { repoPath, config });
}

export function getEditorSettings(): Promise<EditorSettings> {
  return invoke("get_editor_settings");
}

export function getProjectSettings(): Promise<ProjectSettings> {
  return invoke("get_project_settings");
}

export function saveEditorSettings(settings: EditorSettings): Promise<void> {
  return invoke("save_editor_settings", { settings });
}

export function saveProjectSettings(settings: ProjectSettings): Promise<void> {
  return invoke("save_project_settings", { settings });
}

export function getKeybindingSettings(): Promise<KeybindingSettings> {
  return invoke("get_keybinding_settings");
}

export function saveKeybindingSettings(settings: KeybindingSettings): Promise<void> {
  return invoke("save_keybinding_settings", { settings });
}

export function getTerminalSettings(): Promise<TerminalSettings> {
  return invoke("get_terminal_settings");
}

export function saveTerminalSettings(settings: TerminalSettings): Promise<void> {
  return invoke("save_terminal_settings", { settings });
}

export function listMonospaceFamilies(): Promise<FontFamily[]> {
  return invoke("list_monospace_families");
}

export function loadFontFamily(family: string): Promise<FontFaceData[]> {
  return invoke("load_font_family", { family });
}

export function openInEditor(
  repoPath: string,
  editorOverride?: PreferredEditor | null,
): Promise<void> {
  return invoke("open_in_editor", {
    repoPath,
    editorOverride: editorOverride ?? null,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

// ── PTY commands ────────────────────────────────────────────────────

export function spawnPty(
  command: string,
  args: string[] | null,
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number,
  colorTheme: PtyColorTheme,
  onMessage: (msg: PtyOutput) => void,
): Promise<number> {
  const channel = new Channel<PtyOutput>();
  channel.onmessage = onMessage;
  return invoke("spawn_pty", {
    command,
    args,
    cwd,
    env,
    cols,
    rows,
    colorTheme,
    onData: channel,
  });
}

export function writePty(ptyId: number, data: string): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export function acknowledgePtyOutput(ptyId: number, bytes: number): Promise<void> {
  return invoke("acknowledge_pty_output", { ptyId, bytes });
}

export function updatePtyColorTheme(colorTheme: PtyColorTheme): Promise<void> {
  return invoke("update_pty_color_theme", { colorTheme });
}

export function resizePty(
  ptyId: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_pty", { ptyId, cols, rows });
}

export function killPty(ptyId: number): Promise<void> {
  return invoke("kill_pty", { ptyId });
}

export interface SessionTitleMatch {
  sessionId: string;
  title: string | null;
}

export function resolveSessionTitle(
  ptyId: number,
  assistantId: string,
  repoPath: string,
  startedAfterMs: number,
  sessionId: string | null,
): Promise<SessionTitleMatch | null> {
  return invoke("resolve_session_title", {
    ptyId,
    assistantId,
    repoPath,
    startedAfterMs,
    sessionId,
  });
}

export function getAgentRuntimeStatus(
  ptyId: number,
  assistantId: string,
  repoPath: string,
  sessionId: string | null,
): Promise<AgentRuntimeStatus | null> {
  return invoke("get_agent_runtime_status", {
    ptyId,
    assistantId,
    repoPath,
    sessionId,
  });
}

export function upsertSessionHistory(record: SessionHistoryUpsert): Promise<void> {
  return invoke("upsert_session_history", { record });
}

export function recordSessionHistoryActivity(
  provider: string,
  sessionId: string,
  timestamp: number,
  ended: boolean,
): Promise<void> {
  return invoke("record_session_history_activity", {
    provider,
    sessionId,
    timestamp,
    ended,
  });
}

export function listSessionHistory(
  projectPath: string | null = null,
  query: string | null = null,
  limit = 50,
): Promise<SessionHistoryEntry[]> {
  return invoke("list_session_history", { projectPath, query, limit });
}

// ── App lifecycle commands ────────────────────────────────────────

export function shutdownAndQuit(): Promise<void> {
  return invoke("shutdown_and_quit");
}

// ── File watcher commands ─────────────────────────────────────────

export function watchRepo(path: string): Promise<void> {
  return invoke("watch_repo", { path });
}

export function unwatchRepo(path: string): Promise<void> {
  return invoke("unwatch_repo", { path });
}

// ── Git commands ──────────────────────────────────────────────────

export function isGitRepo(path: string): Promise<boolean> {
  return invoke("is_git_repo", { path });
}

export function gitInit(path: string): Promise<void> {
  return invoke("git_init", { path });
}

export function gitCurrentBranch(path: string): Promise<string> {
  return invoke("git_current_branch", { path });
}

export function gitListBranches(path: string): Promise<string[]> {
  return invoke("git_list_branches", { path });
}

// ── Todo commands ───────────────────────────────────────────────────

export function readTodos(repoPath: string): Promise<TodoFile[]> {
  return invoke("read_todos", { repoPath });
}

export function toggleTodo(
  filePath: string,
  line: number,
  expectedText: string,
  checked: boolean,
): Promise<void> {
  return invoke("toggle_todo", { filePath, line, expectedText, checked });
}

export function addTodo(
  repoPath: string,
  filePath: string | null,
  text: string,
  sectionLine: number | null,
  kanban: boolean,
): Promise<void> {
  return invoke("add_todo", { repoPath, filePath, text, sectionLine, kanban });
}

export function moveTodo(
  filePath: string,
  line: number,
  expectedText: string,
  targetSectionLine: number,
  setChecked: boolean | null,
): Promise<void> {
  return invoke("move_todo", { filePath, line, expectedText, targetSectionLine, setChecked });
}

export function listSkills(repoPath: string): Promise<SkillInfo[]> {
  return invoke("list_skills", { repoPath });
}

export function setupSkill(repoPath: string, name: string): Promise<void> {
  return invoke("setup_skill", { repoPath, name });
}

export function removeSkill(repoPath: string, name: string): Promise<void> {
  return invoke("remove_skill", { repoPath, name });
}

export function gitListWorktrees(path: string): Promise<WorktreeEntry[]> {
  return invoke("git_list_worktrees", { path });
}

export function gitCreateWorktree(path: string, branchName: string): Promise<CreatedWorktree> {
  return invoke("git_create_worktree", { path, branchName });
}

export function gitStatus(path: string): Promise<GitStatus> {
  return invoke("git_status", { path });
}

export function gitChangedFiles(path: string): Promise<ChangedFile[]> {
  return invoke("git_changed_files", { path });
}

export function gitFileDiff(path: string, filePath: string, staged: boolean): Promise<string> {
  return invoke("git_file_diff", { path, filePath, staged });
}

/** Read a file's contents for preview in file-viewer mode. `source` is one
 *  of: "working" (from disk), "staged" (from git index), "head" (from HEAD). */
export function gitFileContents(
  path: string,
  filePath: string,
  source: "working" | "staged" | "head",
): Promise<string> {
  return invoke("git_file_contents", { path, filePath, source });
}

/** List all files known to git — tracked + untracked-but-not-ignored.
 *  Returns repo-relative paths, same set a user would consider "files in
 *  this project" (build artifacts and node_modules are excluded). */
export function gitListFiles(path: string): Promise<string[]> {
  return invoke("git_list_files", { path });
}

export function gitSwitchBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_switch_branch", { path, branchName });
}

export function gitCreateBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_create_branch", { path, branchName });
}

export function gitDiffStats(path: string): Promise<DiffFileStat[]> {
  return invoke("git_diff_stats", { path });
}

// ── System commands ────────────────────────────────────────────────

export function getUsername(): Promise<string> {
  return invoke("get_username");
}

export function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory");
}

export function getDefaultShell(): Promise<string> {
  return invoke("get_default_shell");
}

export function getComputerName(): Promise<string> {
  return invoke("get_computer_name");
}

export function checkCommandExists(command: string): Promise<boolean> {
  return invoke("check_command_exists", { command });
}

export function getUsageSettings(): Promise<UsageSettings> {
  return invoke("get_usage_settings");
}

export function saveUsageSettings(settings: UsageSettings): Promise<void> {
  return invoke("save_usage_settings", { settings });
}

export function getAllUsageSnapshots(): Promise<ProviderUsageSnapshot[]> {
  return invoke("get_all_usage_snapshots");
}

export function getUsageSnapshot(provider: string): Promise<ProviderUsageSnapshot> {
  return invoke("get_usage_snapshot", { provider });
}

export function getUsageDetails(provider: string, window: string): Promise<LocalUsageDetails> {
  return invoke("get_usage_details", { provider, window });
}

export function getUsageOverview(window: string): Promise<UsageOverview> {
  return invoke("get_usage_overview", { window });
}

export function getProjectAliasReviewQueue(): Promise<UsageProjectAliasReviewItem[]> {
  return invoke("get_project_alias_review_queue");
}

export function getModelsForProvider(provider: string): Promise<string[]> {
  return invoke("get_models_for_provider", { provider });
}

export function refreshUsageData(): Promise<void> {
  return invoke("refresh_usage_data");
}

export interface MemoryStats {
  app_rss: number;
  children_rss: number;
}

export function getMemoryStats(): Promise<MemoryStats> {
  return invoke("get_memory_stats");
}

// ── Port commands ─────────────────────────────────────────────────

export function listListeningPorts(): Promise<PortInfo[]> {
  return invoke("list_listening_ports");
}

export function killPort(pid: number): Promise<void> {
  return invoke("kill_port", { pid });
}

// ── Pi config commands ────────────────────────────────────────────

export function getPiConfig(): Promise<PiConfig> {
  return invoke("get_pi_config");
}

export function savePiSettings(settings: PiSettings): Promise<void> {
  return invoke("save_pi_settings", { settings });
}

export function savePiApiKey(provider: string, apiKey: string): Promise<void> {
  return invoke("save_pi_api_key", { provider, apiKey });
}

export function deletePiApiKey(provider: string): Promise<void> {
  return invoke("delete_pi_api_key", { provider });
}
