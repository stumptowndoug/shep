import type { GitStatus, RepoInfo, UsageBreakdownItem, UsageProvider } from "../../lib/types";
import { buildProjectTree } from "../../lib/projectTree";

export interface UsageTotals {
  tokens: number;
  input: number;
  output: number;
  cache: number;
}

function addTotals(into: UsageTotals, item: UsageBreakdownItem) {
  into.tokens += item.tokens;
  into.input += item.tokensInput;
  into.output += item.tokensOutput;
  into.cache += item.tokensCacheRead + item.tokensCacheWrite;
}

const emptyTotals = (): UsageTotals => ({ tokens: 0, input: 0, output: 0, cache: 0 });

// ── Models ───────────────────────────────────────────────

const WORD_CASE: Record<string, string> = { gpt: "GPT", glm: "GLM", oss: "OSS", deepseek: "DeepSeek", xai: "xAI" };

/**
 * A readable model name from what the agent logged: "claude-opus-5-5" is
 * "Opus 5.5", "~deepseek/deepseek-flash-latest" is "DeepSeek Flash". Placeholder
 * names ("unknown", "<synthetic>") return null.
 */
export function formatModelName(raw: string): string | null {
  let name = raw.trim().replace(/^~/, "");
  if (!name || name === "unknown" || /^<.*>$/.test(name)) return null;
  name = name.slice(name.lastIndexOf("/") + 1);
  // Effort levels like "(Low)" are the same model; logs sometimes cut the closing paren.
  name = name.replace(/\s*\([^)]*\)?\s*$/, "");
  name = name.replace(/[-_](latest|preview|\d{8})$/i, "");
  if (!name) return null;
  // Agents that already log a display name ("Gemini 3.7 Flash") keep it.
  if (/\s/.test(name) || /[A-Z]/.test(name)) return name;

  const parts = name.split(/[-_]/).filter(Boolean);
  if ((parts[0] === "claude" || parts[0] === "cursor") && parts.length > 1) parts.shift();
  const words: string[] = [];
  for (const part of parts) {
    const previous = words[words.length - 1];
    // "5-5" is version 5.5.
    if (/^\d+$/.test(part) && previous && /^\d+(\.\d+)*$/.test(previous)) words[words.length - 1] = `${previous}.${part}`;
    else words.push(part);
  }
  return words
    .map((word) => WORD_CASE[word] ?? (/^o\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

export interface ModelRow extends UsageTotals {
  key: string;
  name: string;
  provider: UsageProvider;
}

/** Models by readable name, with effort variants and truncated names folded together. */
export function groupModels(items: UsageBreakdownItem[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const item of items) {
    const name = formatModelName(item.label);
    if (!name || item.tokens <= 0) continue;
    const key = `${item.provider}\0${name}`;
    const row = rows.get(key) ?? { key, name, provider: item.provider, ...emptyTotals() };
    addTotals(row, item);
    rows.set(key, row);
  }

  // A name cut off mid-word ("Gemini 3.7 Fl") joins the full one from the same agent.
  const list = [...rows.values()];
  for (const row of list) {
    const full = list.find((other) =>
      other !== row
      && other.provider === row.provider
      && other.name.length > row.name.length
      && other.name.startsWith(row.name)
      && /[a-z]/i.test(other.name.charAt(row.name.length)),
    );
    if (!full) continue;
    full.tokens += row.tokens;
    full.input += row.input;
    full.output += row.output;
    full.cache += row.cache;
    rows.delete(row.key);
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens);
}

// ── Projects ─────────────────────────────────────────────

export interface ProjectRow extends UsageTotals {
  repo: RepoInfo;
  sessions: number;
  providers: UsageProvider[];
}

export interface ProjectUsage {
  rows: ProjectRow[];
  /** Usage in folders that aren't Shep projects, or that an agent didn't name. */
  other: UsageTotals & { folders: number };
}

/** Claude names its log folders after the path, with every other character turned into "-". */
const encodePath = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Agents record projects differently: Claude by encoded path, Codex and others
 * by folder name. Match each to a Shep project, rolling worktrees into their
 * main checkout, and pool the rest.
 */
export function matchProjects(
  items: UsageBreakdownItem[],
  repos: RepoInfo[],
  gitStatuses: Record<string, GitStatus | undefined>,
): ProjectUsage {
  const rootOf = new Map<string, RepoInfo>();
  for (const node of buildProjectTree(repos, gitStatuses)) {
    rootOf.set(node.repo.path, node.repo);
    for (const worktree of node.worktrees) rootOf.set(worktree.path, node.repo);
  }

  const byEncoded = new Map<string, RepoInfo>();
  const byName = new Map<string, RepoInfo | null>();
  for (const repo of repos) {
    byEncoded.set(encodePath(repo.path), repo);
    // A folder name shared by two projects can't say which one it was.
    byName.set(repo.name, byName.has(repo.name) ? null : repo);
  }

  const rows = new Map<string, ProjectRow>();
  const other = { ...emptyTotals(), folders: 0 };
  const otherLabels = new Set<string>();
  for (const item of items) {
    if (item.tokens <= 0) continue;
    const label = item.label.trim();
    const repo = label.startsWith("/")
      ? repos.find((candidate) => candidate.path === label.replace(/\/+$/, ""))
      : byEncoded.get(label) ?? byName.get(label) ?? undefined;
    const root = repo ? rootOf.get(repo.path) ?? repo : null;
    if (!root) {
      addTotals(other, item);
      otherLabels.add(label);
      continue;
    }
    const row = rows.get(root.path) ?? { repo: root, sessions: 0, providers: [], ...emptyTotals() };
    addTotals(row, item);
    row.sessions += item.sessions ?? 0;
    if (!row.providers.includes(item.provider)) row.providers.push(item.provider);
    rows.set(root.path, row);
  }
  other.folders = otherLabels.size;
  return { rows: [...rows.values()].sort((a, b) => b.tokens - a.tokens), other };
}
