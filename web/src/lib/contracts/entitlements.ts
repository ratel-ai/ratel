/**
 * What an organization may have and use. The open-source edition has no plans and answers
 * "unlimited"; the Cloud edition answers from its billing tables. Pure and synchronous on
 * purpose, except the event counter: callers hold the organization row already and decide
 * inline (a creation path, a page slice), and the Cloud side keeps the plan columns on the row
 * it is handed. The two event-quota operations are async because the counting edition reads
 * and writes a table for them.
 */
export interface PlanLimits {
  maxProjects: number;
  maxSkillsPerProject: number;
  maxMembers: number;
  monthlyEventLimit: number;
  embeddingMonthlyAllowanceUsd: number;
  matchQualityRunsPerMonth: number;
  agentHealthSignalsShown: number;
  agentHealthEvidenceTurns: number;
  agentHealthWindowDays: number;
  toolPickerMonthlyAllowanceUsd: number;
  /**
   * How many trace properties of its own (not standard ones) a project may index (RTL-395). Zero:
   * indexing is not on the plan. Optional so an edition built against an older core still
   * type-checks; absent, it reads as zero. Core caps it at 20 whatever the plan answers.
   */
  maxIndexedPropertiesPerProject?: number;
}

/**
 * The organization as the port sees it: its id and any per-organization overrides, plus
 * whatever else the row carries (the Cloud adapter reads its plan columns from there).
 */
export type OrgLimitView = {
  id: string;
  limitOverrides?: Partial<PlanLimits> | null;
} & Record<string, unknown>;

/** Countable resources with a creation cap. */
export type QuotaKey = "maxProjects" | "maxSkillsPerProject" | "maxMembers";

/** Per-period allowances, as opposed to caps on what may exist. */
export type MeteredFeatureKey = "matchQualityRunsPerMonth";

export type QuotaResult =
  | { ok: true }
  | { ok: false; plan: string; limit: number; message: string };

export type FeatureAccess =
  | { ok: true; limit: number; used: number; remaining: number }
  | { ok: false; reason: "not_on_plan"; plan: string; message: string }
  | { ok: false; reason: "exhausted"; plan: string; limit: number; message: string };

/**
 * The answer to "may this organization accept more events this period?", asked before an ingest
 * write. `used` and `limit` let the caller report how far over the cap the organization is.
 */
export type EventQuotaResult =
  | { ok: true }
  | { ok: false; plan: string; limit: number; used: number; message: string };

/**
 * An organization's plan and subscription state as the console and the MCP server report it.
 * Only an edition that sells plans has one.
 */
export type PlanSummary = {
  /** The plan identifier, as `planId` answers it. */
  id: string;
  /** Its display name ("Plus"). */
  name: string;
  /** Whether the plan is a paid one. */
  paid: boolean;
  /** The billing provider's subscription status, null with no subscription. */
  subscriptionStatus: string | null;
  /** Paid, with a failed renewal still being retried. */
  pastDue: boolean;
  /** End of the current paid period (ISO 8601), null when unknown. */
  currentPeriodEnd: string | null;
  /** Whether the organization picks and changes its own plan; false when it is set by hand. */
  selfServeBilling: boolean;
};

/** The plan table of an edition that sells plans. */
export type PlanCatalog = {
  /** The organization's plan and subscription state. */
  summary(org: OrgLimitView): PlanSummary;
  /** The cheapest plan whose Agent health window reaches `days`: its id. */
  withAgentHealthWindow(days: number): string;
  /**
   * The cheapest plan that shows every Agent health issue with its example turns: its id. The
   * locks on hidden issues and examples name it ("Example turns are on Plus."). Optional so an
   * edition built against an older core still type-checks; without it the locks name no plan.
   */
  withFullAgentHealth?(): string;
  /** A plan's display name, by id. */
  name(planId: string): string;
};

export type EntitlementsPort = {
  /**
   * The edition's plans, when it sells them. Absent in the open-source edition: no plan is
   * named, no billing is self-serve, and the quota tool carries no plan block.
   */
  plans?: PlanCatalog;
  /** A short plan identifier for display and analytics (`"oss"`, `"free"`, `"pro"`, ...). */
  planId(org: OrgLimitView): string;
  getLimits(org: OrgLimitView): PlanLimits;
  /** Whether creating one more `key` is allowed given the current count. */
  checkQuota(org: OrgLimitView, key: QuotaKey, currentCount: number): QuotaResult;
  /** Whether a metered feature is on the plan and has budget left this period. */
  checkMeteredFeature(
    org: OrgLimitView,
    key: MeteredFeatureKey,
    used: number,
    noun: string,
  ): FeatureAccess;
  /**
   * Before an ingest write: whether the organization may accept more events in the current
   * period. Async, unlike the operations above, because an edition that counts keeps the counter
   * in a table (and resets an elapsed period here). The open-source edition has no cap.
   */
  checkEventQuota(org: OrgLimitView): Promise<EventQuotaResult>;
  /**
   * After an ingest write: count the events actually stored, which is only known then. Two
   * operations rather than one so a batch partly rejected by validation is never over-counted.
   * Best-effort: an implementation must never throw into the caller, and the ingest result never
   * depends on it. `stored` may be 0 (nothing to count; the caller may skip the call, as upstream
   * does, or make it) and is never negative.
   */
  recordEventUsage(org: OrgLimitView, stored: number): Promise<void>;
};
