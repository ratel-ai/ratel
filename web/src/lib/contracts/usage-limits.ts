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
  // A run VM is warm for a few minutes and many runs reuse it.
  sandbox_vm_starts_per_day: 500,
  // The VM starts of all projects of one organization, so more projects do not add starts.
  sandbox_org_vm_starts_per_day: 5_000,
  // The VM starts of all projects of this deployment: they share one provider account. The hard
  // values only stop a typo; the defaults below fit the plan of the account.
  sandbox_account_vm_starts_per_minute: 1_000,
  sandbox_account_vm_starts_per_hour: 20_000,
  sandbox_account_vm_starts_per_day: 100_000,
};

/**
 * The limits of a deployment with no setting. The account budgets fit the paid plan of the provider
 * (12 starts a minute, 60 an hour, 200 a day); an operator with a larger plan raises them up to the
 * hard limits (`SANDBOX_ACCOUNT_VM_STARTS_PER_*`). One organization gets at most half the account.
 */
export const SANDBOX_DEFAULT_LIMITS = {
  ...SANDBOX_HARD_LIMITS,
  sandbox_org_vm_starts_per_day: 100,
  sandbox_account_vm_starts_per_minute: 12,
  sandbox_account_vm_starts_per_hour: 60,
  sandbox_account_vm_starts_per_day: 200,
} satisfies Record<keyof typeof SANDBOX_HARD_LIMITS, number>;

export type UsageLimitName = keyof typeof SANDBOX_HARD_LIMITS;
export type UsageLimitValues = Readonly<Record<UsageLimitName, number>>;

/** What a project consumes. */
export type UsageKind = "sandbox_run" | "sandbox_version" | "sandbox_vm_start";

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
  /** The VM seconds that a run used, rounded up. Only a `sandbox_run` has it. */
  seconds?: number;
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
