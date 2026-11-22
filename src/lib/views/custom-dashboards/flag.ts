import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_CUSTOM_DASHBOARDS` (ratel-cloud RC-887..RC-889, upstream's `cloud-custom-dashboards`): the
 * pages, their writes and the MCP tools `list_dashboards` and `get_dashboard`. In its own file so
 * a caller outside the session (the MCP server) reads the switch without the session code.
 *
 * Owned (ADR-0030): a core switch, off by default. Without the edition's flags port it is one
 * switch for the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the
 * open-source edition); with it, the edition decides it for the person, as upstream's session
 * flag, and for an MCP caller with the project (`featureEnabled`). Upstream's key name stays.
 */
export const CUSTOM_DASHBOARDS_FLAG = "FF_CUSTOM_DASHBOARDS" as const;

/** The switch for this subject (the signed-in person, at least). Never throws: a failed decision is off. */
export function customDashboardsEnabledFor(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(CUSTOM_DASHBOARDS_FLAG, subject, deps);
}

/**
 * The switch for an MCP caller with no session: `project:<id>` for a key, the person's
 * identity-provider id otherwise. Upstream's `sessionFlagForActor(CUSTOM_DASHBOARDS_FLAG, …)`.
 */
export function customDashboardsEnabledForActor(
  projectId: string,
  actor: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return customDashboardsEnabledFor({ projectId, actor }, deps);
}
