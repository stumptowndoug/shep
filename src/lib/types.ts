// ── Config types (match Rust structs) ────────────────────────────────

export interface RepoInfo {
  path: string;
  name: string;
}

export interface CommandConfig {
  name: string;
  command: string;
  autostart: boolean;
  env: Record<string, string>;
  cwd: string | null;
}

export interface WorkspaceConfig {
  name: string;
  commands: CommandConfig[];
  assistants: AssistantConfig[];
}

export interface RegisteredRepo {
  path: string;
  workspace: WorkspaceConfig;
}

export type PreferredEditor = "vscode" | "zed" | "cursor" | "sublime_text";

export interface EditorSettings {
  preferredEditor: PreferredEditor | null;
}

export interface KeybindingSettings {
  shiftEnterNewline: boolean;
  optionDeleteWord: boolean;
  cmdKClear: boolean;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalSettings {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  fontFamily: string;
  fontSize: number;
}

// ── Runtime state types ─────────────────────────────────────────────

export type CommandStatus = "stopped" | "running" | "crashed";

export interface CommandState {
  name: string;
  command: string;
  status: CommandStatus;
  ptyId: number | null;
  autostart: boolean;
  env: Record<string, string>;
  cwd: string | null;
}

export type SessionMode = "standard" | "yolo";

export interface TerminalTab {
  id: string;
  label: string;
  ptyId: number;
  repoPath: string;
  commandName: string | null; // null = blank shell or assistant
  assistantId: string | null; // null = not an assistant tab
  sessionMode: SessionMode | null; // null = not an assistant tab
}

// ── Tab activity tracking ────────────────────────────────────────────

export interface TabActivity {
  alive: boolean;
  active: boolean;
  exitCode: number | null;
  bell: boolean;
}

// ── Coding assistants ───────────────────────────────────────────────

export interface CodingAssistant {
  id: string;
  name: string;
  command: string;
  yoloFlag: string | null;
}

export interface AssistantConfig {
  id: string;
  name: string;
  command: string;
  yoloFlag: string | null;
}

// ── Git status ──────────────────────────────────────────────────────

export interface GitStatus {
  is_git_repo: boolean;
  branch: string;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  worktree_parent: string | null;
}

// ── Git worktree ─────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  is_main: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

// ── Git changed files ────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  status: string;         // "M", "A", "D", "R", "?"
  area: string;           // "staged", "unstaged", "untracked"
  old_path: string | null;
}

// ── Port info ───────────────────────────────────────────────────────

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
  cwd: string;
  project: string;
  framework: string;
  uptime: string;
  memory_kb: number;
}

// ── PTY output ──────────────────────────────────────────────────────

export type PtyOutput =
  | { event: "data"; data: string }
  | { event: "exit"; data: { code: number } };

export interface PtyColorTheme {
  foreground: string;
  background: string;
  palette: string[];
}

// ── Usage ──────────────────────────────────────────────────────────

export type UsageProvider = "codex" | "claude" | "gemini" | "opencode";

export interface UsageSettings {
  showClaude: boolean;
  showCodex: boolean;
  showGemini: boolean;
  showOpencode: boolean;
}
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";

export interface UsageWindowSnapshot {
  provider: UsageProvider;
  window: string;
  label: string;
  sourceType: UsageSourceType;
  confidence: UsageConfidence;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  tokenTotal: number | null;
  paceStatus: string | null;
}

export interface UsageNamedTokens {
  name: string;
  tokens: number;
  cost: number | null;
}

export interface UsageTask {
  id: string;
  label: string;
  tokens: number;
  cost: number | null;
  model: string | null;
  project: string | null;
  updatedAt: string | null;
}

export interface UsageProject {
  name: string;
  tokens: number;
  cost: number | null;
  sessions: number | null;
}

export interface UsageTrendProviderValue {
  provider: UsageProvider;
  tokens: number;
  cost: number | null;
}

export interface UsageTrendBucket {
  start: number;
  end: number;
  label: string;
  tokens: number;
  cost: number | null;
  providers: UsageTrendProviderValue[];
}

export interface UsageOverviewProvider {
  provider: UsageProvider;
  tokens: number;
  cost: number | null;
  sharePercent: number;
  trend: number[];
}

export interface UsageBreakdownItem {
  provider: UsageProvider;
  label: string;
  tokens: number;
  cost: number | null;
  sessions: number | null;
  trend: number[];
}

export interface UsageOverview {
  window: string;
  totalTokens: number;
  totalCost: number | null;
  activeProjects: number;
  activeSessions: number;
  providers: UsageOverviewProvider[];
  trend: UsageTrendBucket[];
  topModels: UsageBreakdownItem[];
  topProjects: UsageBreakdownItem[];
}

export interface LocalUsageDetails {
  sourceType: "local";
  confidence: UsageConfidence;
  tokensTotal: number;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCached: number | null;
  tokensThoughts: number | null;
  tokens5h: number;
  tokens7d: number;
  tokens30d: number;
  costTotal: number | null;
  cost5h: number | null;
  cost7d: number | null;
  cost30d: number | null;
  topModels: UsageNamedTokens[];
  topTasks: UsageTask[];
  topProjects: UsageProject[];
}

export interface ProviderUsageSnapshot {
  provider: UsageProvider;
  status: string;
  fetchedAt: string;
  summaryWindows: UsageWindowSnapshot[];
  extraWindows: UsageWindowSnapshot[];
  localDetails: LocalUsageDetails | null;
  error: string | null;
}
