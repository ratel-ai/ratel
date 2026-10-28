import { composition } from "@/lib/composition/ports";
import type {
  FeatureAccess,
  MeteredFeatureKey,
  OrgLimitView,
  PlanLimits,
  QuotaKey,
  QuotaResult,
} from "@/lib/contracts/entitlements";

/**
 * The entitlements shim: the upstream function names over the entitlements port, so every
 * caller keeps its import and its call. The numbers come from the composed edition: unlimited
 * in open source, the plan tables in Cloud.
 */
export type { FeatureAccess, MeteredFeatureKey, OrgLimitView, PlanLimits, QuotaKey, QuotaResult };
export type QuotaBlocked = Exclude<QuotaResult, { ok: true }>;

/** A short plan identifier for display and analytics; `"oss"` in the open-source edition. */
export type PlanId = string;

export function resolvePlanId(org: OrgLimitView): PlanId {
  return composition.entitlements.planId(org);
}

/** Whether the plan is a paid one. Open source has no paywall, so everything is reachable. */
export function hasPaidAccess(org: OrgLimitView): boolean {
  return resolvePlanId(org) !== "free";
}

/** Whether the workspace can change its own plan; only a billing edition can. */
export function billingSelfServe(_org: OrgLimitView): boolean {
  return false;
}

export function planLabel(org: OrgLimitView): string {
  const id = resolvePlanId(org);
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Effective limits for an organization: the edition's defaults overlaid with its overrides. */
export function getLimits(org: OrgLimitView): PlanLimits {
  return composition.entitlements.getLimits(org);
}

/** The Agent health limits the page slices its model by. */
export type AgentHealthLimits = Pick<
  PlanLimits,
  "agentHealthSignalsShown" | "agentHealthEvidenceTurns" | "agentHealthWindowDays"
>;

export function getAgentHealthLimits(org: OrgLimitView): AgentHealthLimits {
  const limits = getLimits(org);
  return {
    agentHealthSignalsShown: limits.agentHealthSignalsShown,
    agentHealthEvidenceTurns: limits.agentHealthEvidenceTurns,
    agentHealthWindowDays: limits.agentHealthWindowDays,
  };
}

/**
 * Replace the `editable` overrides with `edited`, keeping every other override as it was. Null
 * when nothing is left, which `getLimits` reads as the defaults.
 */
export function mergeLimitOverrides(
  current: Partial<PlanLimits> | null,
  edited: Partial<PlanLimits>,
  editable: readonly (keyof PlanLimits)[],
): Partial<PlanLimits> | null {
  const replaced = new Set<string>(editable);
  const kept = Object.fromEntries(
    Object.entries(current ?? {}).filter(([key]) => !replaced.has(key)),
  ) as Partial<PlanLimits>;
  const merged = { ...kept, ...edited };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** How many of an organization's projects count against `maxProjects`: the demo one does not. */
export function billableProjectCount(projects: ReadonlyArray<{ isDemo?: boolean | null }>): number {
  return projects.reduce((count, project) => count + (project.isDemo ? 0 : 1), 0);
}

/** Whether creating one more `key` is allowed given the current count. */
export function checkQuota(org: OrgLimitView, key: QuotaKey, currentCount: number): QuotaResult {
  return composition.entitlements.checkQuota(org, key, currentCount);
}

/** Whether a plan-gated, metered feature is available right now. */
export function checkMeteredFeature(
  org: OrgLimitView,
  key: MeteredFeatureKey,
  used: number,
  noun: string,
): FeatureAccess {
  return composition.entitlements.checkMeteredFeature(org, key, used, noun);
}
