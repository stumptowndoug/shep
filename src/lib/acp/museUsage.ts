/**
 * Muse has no public quota API; its chat adapter (muse-acp) forwards the
 * subscription windows Muse observed on each response as
 * `_meta.museSubscriptionUsage.usage` (Muse's `SubscriptionUsage`).
 * Returns that reading when it has the fields Shep needs, otherwise null.
 */
export function museSubscriptionUsage(update: unknown): Record<string, unknown> | null {
  const meta = (update as { _meta?: { museSubscriptionUsage?: { usage?: unknown } } } | null)?._meta;
  const usage = meta?.museSubscriptionUsage?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const reading = usage as Record<string, unknown>;
  const window = reading.window as Record<string, unknown> | undefined;
  return typeof reading.observedAtMs === "number" && typeof window?.usedPercent === "number" ? reading : null;
}
