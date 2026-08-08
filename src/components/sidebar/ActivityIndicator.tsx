import type { TabActivity } from "../../lib/types";

export type ActivityIndicatorStatus = "idle" | "running" | "working" | "active" | "done" | "stuck" | "attention" | "failed";

export function getTabActivityStatus(activity: TabActivity | undefined): ActivityIndicatorStatus {
  if (!activity) return "idle";
  if (!activity.alive) return activity.exitCode === 0 ? "idle" : "failed";
  if (activity.bell) return "attention";
  if (activity.agentState === "possibly_stuck") return "stuck";
  if (activity.agentState === "blocked") return "attention";
  if (activity.agentDone) return "done";
  if (activity.agentState === "working") return "working";
  if (activity.agentState === "idle") return "idle";
  if (activity.active) return "active";
  return "running";
}

function statusDescription(status: ActivityIndicatorStatus, activity?: TabActivity): string {
  if (status === "failed") return activity?.exitCode == null ? "Failed" : `Failed with exit code ${activity.exitCode}`;
  if (status === "attention") {
    return activity?.lastNotificationMessage ||
      (activity?.agentState === "blocked"
        ? `Blocked${activity.agentStatusReason ? ` — ${activity.agentStatusReason}` : ""}`
        : "Needs attention");
  }
  if (status === "stuck") {
    return `Possibly stuck${activity?.agentStatusReason ? ` — ${activity.agentStatusReason}` : ""}`;
  }
  if (status === "active") return "Active output";
  if (status === "done") return "Done — ready to review";
  if (status === "working") return `Working${activity?.agentStatusReason ? ` — ${activity.agentStatusReason}` : ""}`;
  if (status === "running") return "Running, quiet";
  return `Idle${activity?.agentStatusReason ? ` — ${activity.agentStatusReason}` : ""}`;
}

export default function ActivityIndicator({
  activity,
  className = "",
}: {
  activity?: TabActivity;
  className?: string;
}) {
  const status = getTabActivityStatus(activity);
  const description = statusDescription(status, activity);

  return (
    <span
      className={`activity-indicator activity-indicator--${status}${className ? ` ${className}` : ""}`}
      title={description}
      aria-label={description}
    />
  );
}
