import type { UsageSettings } from "./types";

export const DEFAULT_USAGE_LIMITS = {
  showClaudeWeeklyLimit: true,
  showClaudeFiveHourLimit: false,
  showAntigravityGeminiWeeklyLimit: true,
  showAntigravityGeminiFiveHourLimit: false,
  showAntigravityClaudeWeeklyLimit: false,
  showAntigravityClaudeFiveHourLimit: false,
} satisfies Partial<UsageSettings>;

export type UsageLimitKey = keyof typeof DEFAULT_USAGE_LIMITS;
export type UsageLimitVisibility = Pick<UsageSettings, UsageLimitKey>;
