/**
 * The one seam for limits and usage (ADR-0004). A caller asks `check` before it consumes
 * something and calls `record` after. It names a limit and gives the present value; it never sees
 * a plan, a price or where a limit comes from. An edition that sells plans can so lower a limit
 * or charge for usage with no change to the callers.
 */

/** The hard limits of one project. An edition may lower them, never raise them. */
export const SANDBOX_HARD_LIMITS = {
  sandbox_concurrent_instances: 50,
  sandbox_run_seconds: 30 * 60,
  sandbox_runs_per_day: 5_000,
  sandbox_versions_per_day: 100,
  // A gzip of `docker save`.
  sandbox_bundle_bytes: 2 * 1024 ** 3,
};

export type UsageLimitName = keyof typeof SANDBOX_HARD_LIMITS;
export type UsageLimitValues = Readonly<Record<UsageLimitName, number>>;

/** What a project consumes. */
export type UsageKind = "sandbox_run" | "sandbox_version";

/** A budget that Ratel pays from, for each organization and UTC day. */
export type DailyBudgetName = "eval_judge";

export type UsageSubject = { organizationId: string; projectId: string };

export type UsageRefusal = {
  ok: false;
  limit: UsageLimitName;
  /** The limit's value. */
  max: number;
  /** The present value, before the request. */
  current: number;
  /** One sentence that names the limit, for the person who asked. */
  message: string;
};

export type UsageCheck = { ok: true } | UsageRefusal;

export type UsageRequest = {
  /** The present value: what the project already has or used in the period. */
  current: number;
  /** What the request adds; 1 by default. */
  amount?: number;
};

export type UsageRecord = {
  kind: UsageKind;
  /** 1 by default. */
  amount?: number;
  /** What was consumed (a run id, a version id). One kind and reference counts one time. */
  reference: string;
};

export type UsageLimitsPort = {
  /** A limit's value for this project. */
  limit(subject: UsageSubject, name: UsageLimitName): Promise<number>;
  /** Whether `current + amount` stays within the limit. */
  check(subject: UsageSubject, name: UsageLimitName, request: UsageRequest): Promise<UsageCheck>;
  /** Records usage. A second call with the same kind and reference changes nothing. */
  record(subject: UsageSubject, usage: UsageRecord): Promise<void>;
  /** The daily budget in USD, or null when Ratel does not pay. */
  dailyBudgetUsd(subject: UsageSubject, name: DailyBudgetName): Promise<number | null>;
};

/** The decision every adapter shares, so a refusal reads the same in each edition. */
export function checkUsageLimit(
  name: UsageLimitName,
  max: number,
  { current, amount = 1 }: UsageRequest,
): UsageCheck {
  if (current + amount <= max) return { ok: true };
  return {
    ok: false,
    limit: name,
    max,
    current,
    message: `The limit ${name} (${max}) is reached: the present value is ${current} and this request adds ${amount}.`,
  };
}
