import {
  checkUsageLimit,
  SANDBOX_HARD_LIMITS,
  type UsageLimitsPort,
  type UsageLimitValues,
  type UsageRecord,
  type UsageSubject,
} from "./usage-limits";

export type InMemoryUsageLimits = UsageLimitsPort & {
  readonly records: ReadonlyArray<UsageSubject & UsageRecord & { amount: number }>;
};

/** The in-memory usage limits, for tests: the records are readable. */
export function createInMemoryUsageLimits(
  overrides: Partial<UsageLimitValues> = {},
): InMemoryUsageLimits {
  const values: UsageLimitValues = { ...SANDBOX_HARD_LIMITS, ...overrides };
  const records = new Map<string, UsageSubject & UsageRecord & { amount: number }>();
  return {
    get records() {
      return [...records.values()];
    },
    async limit(_subject, name) {
      return values[name];
    },
    async check(_subject, name, request) {
      return checkUsageLimit(name, values[name], request);
    },
    async record(subject, usage) {
      const key = `${usage.kind}:${usage.reference}`;
      if (!records.has(key)) records.set(key, { ...subject, amount: 1, ...usage });
    },
    async dailyBudgetUsd() {
      return null;
    },
  };
}
