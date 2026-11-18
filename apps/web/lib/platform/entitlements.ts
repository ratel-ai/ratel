import { composition } from "@/lib/composition/ports";
import type {
  EventQuotaResult,
  FeatureAccess,
  MeteredFeatureKey,
  OrgLimitView,
  PlanLimits,
  PlanSummary,
  QuotaKey,
  QuotaResult,
} from "@/lib/contracts/entitlements";

/**
 * The entitlements shim: the upstream function names over the entitlements port, so every
 * caller keeps its import and its call. The numbers come from the composed edition: unlimited
 * in open source, the plan tables in Cloud.
 */
export type {
  EventQuotaResult,
  FeatureAccess,
  MeteredFeatureKey,
  OrgLimitView,
  PlanLimits,
  PlanSummary,
  QuotaKey,
  QuotaResult,
};
export type QuotaBlocked = Exclude<QuotaResult, { ok: true }>;

/** A short plan identifier for display and analytics; `"oss"` in the open-source edition. */
export type PlanId = string;

/** What plan resolution reads from an organization; the limit view carries it here. */
export type AccountPlanView = OrgLimitView;

export function resolvePlanId(org: OrgLimitView): PlanId {
  return composition.entitlements.planId(org);
}

/** Whether the plan is a paid one. Open source has no paywall, so everything is reachable. */
export function hasPaidAccess(org: OrgLimitView): boolean {
  return resolvePlanId(org) !== "free";
}

/** Whether the workspace can change its own plan; only an edition with plans can. */
export function billingSelfServe(org: OrgLimitView): boolean {
  return composition.entitlements.plans?.summary(org).selfServeBilling ?? false;
}

/** Display label for the organization's plan ("Plus"; "Oss" in the open-source edition). */
export function planLabel(org: OrgLimitView): string {
  return planName(resolvePlanId(org));
}

/** A plan's display name, by id; without an edition's plans, the id capitalized. */
export function planName(planId: string): string {
  const plans = composition.entitlements.plans;
  if (plans) return plans.name(planId);
  return planId.charAt(0).toUpperCase() + planId.slice(1);
}

/** The plan and subscription state, or null when the edition has no plans. */
export function planSummary(org: OrgLimitView): PlanSummary | null {
  return composition.entitlements.plans?.summary(org) ?? null;
}

/**
 * The cheapest plan whose Agent health window reaches `days`, or null when the edition has no
 * plans (a window the limits do not include is then not offered by name).
 */
export function planWithWindow(days: number): string | null {
  return composition.entitlements.plans?.withAgentHealthWindow(days) ?? null;
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

/**
 * Before an ingest write: whether the organization may accept more events this period. Replaces
 * upstream's `resetEventUsageIfElapsed` plus the `monthlyEventLimit` comparison: the edition that
 * counts does both behind the port, and the route keeps its 429 on `ok: false`.
 */
export function checkEventQuota(org: OrgLimitView): Promise<EventQuotaResult> {
  return composition.entitlements.checkEventQuota(org);
}

/**
 * After an ingest write: the upstream name and signature (the organization id, as the ingest
 * code holds it), now over the port. Best-effort by contract, so the caller may `.catch` and log
 * exactly as upstream did.
 */
export function incrementEventUsage(organizationId: string, stored: number): Promise<void> {
  return composition.entitlements.recordEventUsage({ id: organizationId }, stored);
}
