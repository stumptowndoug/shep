import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  RegisteredRepo,
  WorkspaceConfig,
  PtyColorTheme,
  PtyOutput,
  GitStatus,
  ChangedFile,
  WorktreeEntry,
  CreatedWorktree,
  EditorSettings,
  KeybindingSettings,
  TerminalSettings,
  PreferredEditor,
  ProviderUsageSnapshot,
  LocalUsageDetails,
  UsageSettings,
  UsageOverview,
  PortInfo,
  FontFile,
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

export function saveEditorSettings(settings: EditorSettings): Promise<void> {
  return invoke("save_editor_settings", { settings });
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

export function gitPushBranch(path: string, branch: string): Promise<void> {
  return invoke("git_push_branch", { path, branch });
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

export function gitStageFile(path: string, filePath: string): Promise<void> {
  return invoke("git_stage_file", { path, filePath });
}

export function gitStageAll(path: string): Promise<void> {
  return invoke("git_stage_all", { path });
}

export function gitCommit(path: string, message: string): Promise<void> {
  return invoke("git_commit", { path, message });
}

export function gitUnstageFile(path: string, filePath: string): Promise<void> {
  return invoke("git_unstage_file", { path, filePath });
}

export function gitSwitchBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_switch_branch", { path, branchName });
}

export function gitCreateBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_create_branch", { path, branchName });
}

// ── System commands ────────────────────────────────────────────────

export function getUsername(): Promise<string> {
  return invoke("get_username");
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

// ── Font commands ───────────────────────────────────────────────────

export function resolveFontFiles(familyName: string): Promise<FontFile[]> {
  return invoke("resolve_font_files", { familyName });
}
