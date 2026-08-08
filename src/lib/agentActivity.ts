import type { AgentRuntimeState } from "./types";

export function nextAgentDoneState(
  previousState: AgentRuntimeState | null,
  previousDone: boolean,
  nextState: AgentRuntimeState | null,
  isViewed: boolean,
): boolean {
  if (isViewed || nextState == null) return false;
  if (nextState === "working" || nextState === "blocked" || nextState === "possibly_stuck") {
    return false;
  }
  if (nextState !== "idle") return previousDone;
  return previousDone || previousState === "working" || previousState === "possibly_stuck";
}
