/**
 * What an organization may have and use. The open-source edition has no plans and answers
 * "unlimited"; the Cloud edition answers from its billing tables. Pure and synchronous on
 * purpose: callers hold the organization row already and decide inline (a creation path, a
 * page slice), and the Cloud side keeps the plan columns on the row it is handed.
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

export type EntitlementsPort = {
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
};
