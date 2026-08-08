import type { AgentLabelMode, TerminalTabData } from "./types";

export interface AgentDisplayLabel {
  text: string;
  isTitle: boolean;
}

export function repositoryName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

export function agentDisplayLabel(
  tab: TerminalTabData,
  mode: AgentLabelMode,
  repoName = repositoryName(tab.repoPath),
): AgentDisplayLabel {
  if (tab.labelSource === "user" || mode === "title") {
    return { text: tab.label, isTitle: true };
  }
  return { text: repoName, isTitle: false };
}
