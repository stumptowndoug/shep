import type { Terminal } from "@xterm/xterm";
import type { AgentSemanticState, AgentStatusObservation } from "./types";

export type AgentScreenConfidence = "explicit" | "fallback" | "preserve";

export interface AgentScreenDetection {
  state: AgentSemanticState | null;
  confidence: AgentScreenConfidence;
  ruleId: string;
  reason: string;
  evidence: string | null;
}

export interface ProviderAgentObservation {
  state: AgentSemanticState;
  updatedAt: number;
}

export function resolveAgentStatusAuthority(
  screen: AgentScreenDetection | null,
  screenUpdatedAt: number,
  provider: ProviderAgentObservation | null,
  fallbackAllowed: boolean,
): AgentStatusObservation | null {
  if (screen?.confidence === "preserve") return null;

  if (screen?.confidence === "explicit" && screen.state) {
    return {
      state: screen.state,
      updatedAt: screenUpdatedAt,
      source: "screen",
      reason: screen.reason,
      ruleId: screen.ruleId,
    };
  }

  // Claude's status file is useful supplemental evidence, but a blocked state
  // is only promoted when the rendered terminal also shows a known blocker.
  if (provider && provider.state !== "blocked") {
    return {
      state: provider.state,
      updatedAt: provider.updatedAt,
      source: "provider",
      reason: "Claude reported its current runtime state",
      ruleId: "claude-runtime-status",
    };
  }

  if (fallbackAllowed && screen?.state) {
    return {
      state: screen.state,
      updatedAt: screenUpdatedAt,
      source: "fallback",
      reason: screen.reason,
      ruleId: screen.ruleId,
    };
  }

  return null;
}

function matched(
  state: AgentSemanticState,
  ruleId: string,
  reason: string,
  evidence: string,
): AgentScreenDetection {
  return { state, confidence: "explicit", ruleId, reason, evidence };
}

function fallback(assistantId: string): AgentScreenDetection {
  return {
    state: "idle",
    confidence: "fallback",
    ruleId: "default-known-agent-idle",
    reason: `No recognized ${assistantId} working or blocked UI is visible`,
    evidence: null,
  };
}

function preserve(ruleId: string, reason: string, evidence: string): AgentScreenDetection {
  return { state: null, confidence: "preserve", ruleId, reason, evidence };
}

function lastNonEmptyLines(screen: string, count: number): string {
  return screen
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join("\n");
}

function evidenceFor(text: string, needle: string): string {
  return text
    .split("\n")
    .find((line) => line.toLocaleLowerCase().includes(needle.toLocaleLowerCase()))
    ?.trim() ?? needle;
}

function detectClaude(screen: string, title: string): AgentScreenDetection {
  const lower = screen.toLocaleLowerCase();
  const recent = lastNonEmptyLines(screen, 12);
  const recentLower = recent.toLocaleLowerCase();

  if (
    recentLower.includes("showing detailed transcript") &&
    (recentLower.includes("to toggle") || recentLower.includes("scroll"))
  ) {
    return preserve(
      "claude-transcript-viewer",
      "Claude is showing transcript history rather than its live prompt",
      evidenceFor(recent, "showing detailed transcript"),
    );
  }

  const liveForm = recentLower.includes("esc to cancel") && (
    recentLower.includes("enter to confirm") ||
    recentLower.includes("enter to select") ||
    recentLower.includes("do you want to proceed?")
  );
  if (liveForm || (lower.includes("run a dynamic workflow?") && lower.includes("esc to cancel"))) {
    return matched(
      "blocked",
      "claude-live-form",
      "Claude is waiting for a visible confirmation or selection",
      evidenceFor(recent, liveForm ? "esc to cancel" : "run a dynamic workflow?"),
    );
  }

  const permissionPrompt = lower.includes("do you want to proceed?") && (
    lower.includes("bash command") ||
    lower.includes("tab to amend") ||
    lower.includes("ctrl+e to explain")
  );
  if (permissionPrompt) {
    return matched(
      "blocked",
      "claude-permission-prompt",
      "Claude is waiting for permission",
      evidenceFor(screen, "do you want to proceed?"),
    );
  }

  if (/^[\u2800-\u28ff]\s/u.test(title) || /^\*+\s/.test(title)) {
    return matched(
      "working",
      "claude-working-title",
      "Claude's terminal title contains its working marker",
      title.trim(),
    );
  }

  if (/^\s*❯/mu.test(recent) && !recentLower.includes("esc to cancel")) {
    return matched(
      "idle",
      "claude-live-prompt",
      "Claude's live prompt is visible",
      evidenceFor(recent, "❯"),
    );
  }

  return fallback("Claude");
}

function detectCodex(screen: string, title: string): AgentScreenDetection {
  const recent = lastNonEmptyLines(screen, 12);
  const recentLower = recent.toLocaleLowerCase();

  if (
    recentLower.includes("↑/↓ to scroll") &&
    recentLower.includes("pgup/pgdn") &&
    recentLower.includes("q to quit")
  ) {
    return preserve(
      "codex-transcript-viewer",
      "Codex is showing transcript history rather than its live prompt",
      evidenceFor(recent, "q to quit"),
    );
  }

  if (title.toLocaleLowerCase().includes("action required")) {
    return matched(
      "blocked",
      "codex-action-required-title",
      "Codex's terminal title says action is required",
      title.trim(),
    );
  }

  const blocker = [
    "press enter to confirm or esc to cancel",
    "enter to submit answer",
    "enter to submit all",
    "allow command?",
  ].find((needle) => recentLower.includes(needle));
  if (blocker) {
    return matched(
      "blocked",
      "codex-live-blocker",
      "Codex is waiting for a visible answer or approval",
      evidenceFor(recent, blocker),
    );
  }

  if (/\[(?:y\/n|Y\/n|y\/N)\]/u.test(recent) || recentLower.includes("yes (y)")) {
    return matched(
      "blocked",
      "codex-confirmation-prompt",
      "Codex is waiting for a yes/no response",
      evidenceFor(recent, recentLower.includes("yes (y)") ? "yes (y)" : "[y/n]"),
    );
  }

  if (/^[\u2800-\u28ff]\s/u.test(title)) {
    return matched(
      "working",
      "codex-working-title",
      "Codex's terminal title contains its working spinner",
      title.trim(),
    );
  }

  const workingLine = recent
    .split("\n")
    .find((line) => /^[•◦]\s+Working\s+\([^)]*esc to interrupt\)/iu.test(line.trim()));
  if (workingLine) {
    return matched(
      "working",
      "codex-working-row",
      "Codex's live working row is visible",
      workingLine.trim(),
    );
  }

  if (title.trim().length > 0) {
    return matched(
      "idle",
      "codex-idle-title",
      "Codex has a stable terminal title without a working or attention marker",
      title.trim(),
    );
  }

  return fallback("Codex");
}

function detectAntigravity(screen: string): AgentScreenDetection {
  const lower = screen.toLocaleLowerCase();
  const recent = lastNonEmptyLines(screen, 8);

  if (
    lower.includes("requesting permission for:") &&
    (lower.includes("do you want to proceed?") || lower.includes("tab amend"))
  ) {
    return matched(
      "blocked",
      "antigravity-permission-prompt",
      "Antigravity is visibly requesting permission",
      evidenceFor(screen, "requesting permission for:"),
    );
  }

  const spinnerLine = recent
    .split("\n")
    .find((line) => /^\s*[\u2800-\u28ff]+\s+\p{Alphabetic}+\w*ing\b/iu.test(line));
  if (spinnerLine) {
    return matched(
      "working",
      "antigravity-spinner",
      "Antigravity's working spinner is visible",
      spinnerLine.trim(),
    );
  }

  const taskLine = recent
    .split("\n")
    .find((line) => /·\s*[1-9][0-9]*\s+tasks?/iu.test(line));
  if (taskLine) {
    return matched(
      "working",
      "antigravity-background-tasks",
      "Antigravity reports active background tasks",
      taskLine.trim(),
    );
  }

  return fallback("Antigravity");
}

function detectOpenCode(screen: string): AgentScreenDetection {
  const recent = lastNonEmptyLines(screen, 12);
  const lower = recent.toLocaleLowerCase();

  if (lower.includes("permission required")) {
    return matched(
      "blocked",
      "opencode-permission-required",
      "OpenCode is visibly requesting permission",
      evidenceFor(recent, "permission required"),
    );
  }

  if (
    lower.includes("esc dismiss") &&
    (lower.includes("enter confirm") || lower.includes("enter submit") || lower.includes("enter toggle"))
  ) {
    return matched(
      "blocked",
      "opencode-question",
      "OpenCode is waiting for a visible answer",
      evidenceFor(recent, "esc dismiss"),
    );
  }

  const interruptHint = ["esc to interrupt", "ctrl+c to interrupt", "press esc to interrupt"]
    .find((needle) => lower.includes(needle));
  if (interruptHint) {
    return matched(
      "working",
      "opencode-interrupt-hint",
      "OpenCode's interrupt hint shows that it is working",
      evidenceFor(recent, interruptHint),
    );
  }

  if (/(?:■|⬝){4,}/u.test(recent)) {
    return matched(
      "working",
      "opencode-progress-bar",
      "OpenCode's progress bar is visible",
      recent.split("\n").find((line) => /(?:■|⬝){4,}/u.test(line))?.trim() ?? "progress bar",
    );
  }

  return fallback("OpenCode");
}

function detectPi(screen: string): AgentScreenDetection {
  const recent = lastNonEmptyLines(screen, 8);
  if (recent.includes("Working...")) {
    return matched(
      "working",
      "pi-working-literal",
      "Pi's working indicator is visible",
      evidenceFor(recent, "Working..."),
    );
  }
  return fallback("Pi");
}

export function detectAgentScreenStatus(
  assistantId: string,
  screen: string,
  title = "",
): AgentScreenDetection {
  switch (assistantId) {
    case "claude":
      return detectClaude(screen, title);
    case "codex":
      return detectCodex(screen, title);
    case "antigravity":
      return detectAntigravity(screen);
    case "opencode":
      return detectOpenCode(screen);
    case "pi":
      return detectPi(screen);
    default:
      return preserve(
        "unsupported-provider",
        `No screen rules are defined for ${assistantId}`,
        assistantId,
      );
  }
}

export function readTerminalBottomScreen(term: Terminal): string {
  const buffer = term.buffer.active;
  const firstRow = Math.max(0, buffer.baseY);
  const lastRow = Math.min(buffer.length - 1, firstRow + term.rows - 1);
  const lines: string[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }

  return lines.join("\n").trimEnd();
}
