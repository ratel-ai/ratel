import { getAgentHealthLimits, type OrgLimitView } from "@/lib/platform/entitlements";

/**
 * May an insight name the run it came from on this organization's plan? Not
 * on a plan without example turns (`agentHealthEvidenceTurns` 0): it names its
 * metric instead. Every surface that resolves lineage (the API route, the Ship
 * breadcrumb) passes this as `LineageContext.traces`, so they agree.
 */
export function lineageShowsTraces(org: OrgLimitView): boolean {
  return getAgentHealthLimits(org).agentHealthEvidenceTurns > 0;
}
