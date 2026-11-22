import type { EntitlementsPort, OrgLimitView, PlanLimits } from "@/lib/contracts/entitlements";

export const OSS_PLAN_ID = "oss";

/**
 * No plans in the open-source edition: every cap is unlimited. The two Agent health knobs that
 * are windows rather than caps keep the widest Cloud values so the pages slice the same way.
 */
export const OSS_LIMITS: PlanLimits = Object.freeze({
  maxProjects: Number.POSITIVE_INFINITY,
  maxSkillsPerProject: Number.POSITIVE_INFINITY,
  maxMembers: Number.POSITIVE_INFINITY,
  monthlyEventLimit: Number.POSITIVE_INFINITY,
  embeddingMonthlyAllowanceUsd: Number.POSITIVE_INFINITY,
  matchQualityRunsPerMonth: Number.POSITIVE_INFINITY,
  agentHealthSignalsShown: Number.POSITIVE_INFINITY,
  agentHealthEvidenceTurns: 6,
  agentHealthWindowDays: 90,
  toolPickerMonthlyAllowanceUsd: Number.POSITIVE_INFINITY,
});

/** Overrides still apply: an operator may lower a limit on purpose through `limit_overrides`. */
function limitsFor(org: OrgLimitView): PlanLimits {
  return org.limitOverrides ? { ...OSS_LIMITS, ...org.limitOverrides } : OSS_LIMITS;
}

export const ossEntitlements: EntitlementsPort = {
  planId() {
    return OSS_PLAN_ID;
  },
  getLimits(org) {
    return limitsFor(org);
  },
  checkQuota(org, key, currentCount) {
    const limit = limitsFor(org)[key];
    if (currentCount < limit) return { ok: true };
    return {
      ok: false,
      plan: OSS_PLAN_ID,
      limit,
      message: `This workspace is limited to ${limit} ${key.replace(/^max/, "").toLowerCase()}.`,
    };
  },
  checkMeteredFeature(org, key, used, noun) {
    const limit = limitsFor(org)[key];
    if (limit <= 0) {
      return {
        ok: false,
        reason: "not_on_plan",
        plan: OSS_PLAN_ID,
        message: `${noun} is turned off for this workspace.`,
      };
    }
    if (used >= limit) {
      return {
        ok: false,
        reason: "exhausted",
        plan: OSS_PLAN_ID,
        limit,
        message: `All ${limit} ${noun.toLowerCase()} runs for this period are used.`,
      };
    }
    return {
      ok: true,
      limit,
      used,
      remaining: limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : limit - used,
    };
  },
  // No event cap in the open-source edition, and no counter: an operator's `monthlyEventLimit`
  // override has nothing to compare against, so it is accepted and ignored.
  async checkEventQuota() {
    return { ok: true };
  },
  async recordEventUsage() {},
};
