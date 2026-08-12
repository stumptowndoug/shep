// ── Config types (match Rust structs) ────────────────────────────────

export interface RepoInfo {
  path: string;
  name: string;
  group: string | null;
}

export interface RepoGroup {
  id: string;
  name: string;
  order: number;
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

export type TodoFileStyle = "kanban" | "list";
export type AgentLabelMode = "repository" | "title";

export interface ProjectSettings {
  autoImportWorktrees: boolean;
  agentLabelMode: AgentLabelMode;
  defaultAgentMode: SessionMode;
  showTodos: boolean;
  /** Shape of a lazily created TODO.md. */
  todoFileStyle: TodoFileStyle;
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
  urlAllowlist: string[];
}

export interface FontFamily {
  family: string;
  faceCount: number;
  isNerdFont: boolean;
}

export interface FontFaceData {
  /// Raw TTF/OTF bytes, sent from Rust over IPC as a number array.
  data: number[];
  /// CSS font-weight (100..900).
  weight: number;
  italic: boolean;
  /// CSS font-stretch keyword index (1..9).
  stretch: number;
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
export type TerminalLabelSource = "default" | "terminal" | "session" | "user";

// ── Unified tab model ──────────────────────────────────────────────

export type PanelTabKind = "git" | "commands" | "launcher" | "todos";
export type TabKind = "terminal" | "assistant" | PanelTabKind;

interface TabBase {
  id: string;
  kind: TabKind;
  label: string;
}

export interface TerminalTabData extends TabBase {
  kind: "terminal" | "assistant";
  ptyId: number;
  repoPath: string;
  commandName: string | null;
  assistantId: string | null;
  providerSessionId: string | null;
  sessionMode: SessionMode | null;
  labelSource: TerminalLabelSource;
}

export interface SessionHistoryUpsert {
  provider: string;
  sessionId: string;
  projectPath: string;
  title: string | null;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
}

export interface SessionHistoryEntry extends SessionHistoryUpsert {
  endedAt: number | null;
}

export interface AgentRuntimeStatus {
  status: string;
  statusUpdatedAt: number;
}

export interface PanelTabData extends TabBase {
  kind: PanelTabKind;
}

export type UnifiedTab = TerminalTabData | PanelTabData;

export function panelTabId(kind: PanelTabKind): string {
  return `panel-${kind}`;
}

export const panelTabDefaults: Record<PanelTabKind, { label: string }> = {
  git: { label: "Files" },
  commands: { label: "Commands" },
  launcher: { label: "New Agent" },
  todos: { label: "To-dos" },
};


// ── Tab activity tracking ────────────────────────────────────────────

export interface TabActivity {
  alive: boolean;
  active: boolean;
  exitCode: number | null;
  bell: boolean;
  lastOutputAt: number | null;
  lastAttentionAt: number | null;
  lastNotificationMessage: string | null;
  agentState: AgentRuntimeState | null;
  agentStatusUpdatedAt: number | null;
  agentStatusSource: AgentStatusSource | null;
  agentStatusReason: string | null;
  agentStatusRuleId: string | null;
  agentDone: boolean;
}

export type AgentSemanticState = "working" | "idle" | "blocked";
export type AgentRuntimeState = AgentSemanticState | "possibly_stuck";
export type AgentStatusSource = "provider" | "screen" | "fallback" | "heuristic";

export interface AgentStatusObservation {
  state: AgentRuntimeState;
  updatedAt: number;
  source: AgentStatusSource;
  reason: string;
  ruleId: string | null;
}

// ── Coding assistants ───────────────────────────────────────────────

export interface CodingAssistant {
  id: string;
  name: string;
  command: string;
  yoloFlag: string | null;
  modelFlag: string;
  description?: string;
  docsUrl?: string;
}

export type AssistantConfig = CodingAssistant;

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

// ── Todos (TODO.md files) ────────────────────────────────────────────

export interface TodoItem {
  /** 0-based line index in the file; used for surgical edits. */
  line: number;
  /** Item text with wrapped continuation lines joined in. */
  text: string;
  checked: boolean;
  /** Leading whitespace width, for rendering nested items. */
  indent: number;
  /** Nearest preceding markdown heading, if any. */
  section: string | null;
  /** Line index of that heading. */
  sectionLine: number | null;
}

export interface TodoSection {
  line: number;
  title: string;
  /** Heading level (number of #s). */
  level: number;
}

export interface TodoFile {
  path: string;
  relativePath: string;
  sections: TodoSection[];
  items: TodoItem[];
}

// ── Agent skills ─────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  title: string;
  description: string;
  installed: boolean;
}

// ── Git diff stats ───────────────────────────────────────────────────

export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
}

// ── Git changed files ────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  status: string;         // "M", "A", "D", "R", "?"
  area: string;           // "staged", "unstaged", "untracked"
  old_path: string | null;
}

// ── Port info ───────────────────────────────────────────────────────

// ── Pi config ──────────────────────────────────────────────────────

export interface PiSettings {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}

export interface PiConfig {
  settings: PiSettings;
  configuredProviders: string[];
}

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

export type UsageProvider = "codex" | "cursor" | "claude" | "antigravity" | "gemini" | "opencode" | "pi" | "grok";
export type ConfigurableUsageProvider = Exclude<UsageProvider, "gemini">;

export type BudgetMode = "subscription" | "custom";

export interface ProviderBudgetConfig {
  show: boolean;
  budgetMode: BudgetMode;
  monthlyBudget: number | null;
}

export interface UsageSettings {
  showClaudeFiveHourLimit: boolean;
  claude: ProviderBudgetConfig;
  codex: ProviderBudgetConfig;
  cursor: ProviderBudgetConfig;
  antigravity: ProviderBudgetConfig;
  opencode: ProviderBudgetConfig;
  pi: ProviderBudgetConfig;
  grok: ProviderBudgetConfig;
}
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";
export type UsageCostKind = "recorded" | "estimated" | "included" | "free" | "unknown" | "mixed";
export type UsageCostBasis = "provider" | "local-pricing" | "subscription" | "gateway" | "none";

export interface UsageCost {
  amount: number | null;
  kind: UsageCostKind;
  basis: UsageCostBasis;
  confidence: UsageConfidence;
}

export interface UsageWindowSnapshot {
  provider: UsageProvider;
  windowId: string;
  window: string;
  label: string;
  scope: "session" | "plan" | "billing" | "reporting";
  limit: number | null;
  used: number | null;
  sourceType: UsageSourceType;
  confidence: UsageConfidence;
  costKind: UsageCostKind;
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
  costDetail: UsageCost;
}

export interface UsageTask {
  id: string;
  label: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  model: string | null;
  project: string | null;
  updatedAt: string | null;
}

export interface UsageProject {
  name: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  sessions: number | null;
}

export interface UsageProjectAliasReviewItem {
  rawLabel: string;
  provider: UsageProvider;
  canonicalId: string;
  displayName: string;
  confidence: number;
  reason: string;
  sessions: number;
  tokens: number;
}

export interface UsageTrendProviderValue {
  provider: UsageProvider;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
}

export interface UsageTrendBucket {
  start: number;
  end: number;
  label: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  providers: UsageTrendProviderValue[];
}

export interface UsageOverviewProvider {
  provider: UsageProvider;
  tokens: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensThoughts: number;
  cost: number | null;
  costDetail: UsageCost;
  sharePercent: number;
  trend: number[];
}

export interface UsageBreakdownItem {
  provider: UsageProvider;
  label: string;
  tokens: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensThoughts: number;
  cost: number | null;
  costDetail: UsageCost;
  sessions: number | null;
  trend: number[];
}

export interface UsageOverview {
  window: string;
  totalTokens: number;
  totalCost: number | null;
  totalCostDetail: UsageCost;
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
  costTotalDetail: UsageCost;
  costMonth: number | null;
  costMonthDetail: UsageCost;
  cost5h: number | null;
  cost5hDetail: UsageCost;
  cost7d: number | null;
  cost7dDetail: UsageCost;
  cost30d: number | null;
  cost30dDetail: UsageCost;
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
