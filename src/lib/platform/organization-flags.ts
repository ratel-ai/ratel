import type { CoreFlag, FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * Upstream's `lib/flags-org` seam, for the copied callers that pass its deps along (the Evals
 * area). Upstream decides a flag with its flag vendor per organization; the core decides a core
 * switch with `featureEnabled` (the environment, or the edition's `featureFlags` port). Copied
 * callers keep upstream's `deps` parameter: a test that hands `evaluate` decides the switch
 * itself, and the default (no `evaluate`) is the core's decision.
 */
export interface OrganizationFlagDeps {
  isConfigured?: () => boolean;
  evaluate?: (
    key: string,
    distinctId: string,
    options: { personProperties: Record<string, string>; sendFeatureFlagEvents: false },
  ) => Promise<boolean | undefined>;
  readOverride?: (key: string) => unknown;
  reportError?: (message: string, error: unknown, fields: Record<string, unknown>) => void;
  /** The core's own deps for `featureEnabled` (a test's environment or port). */
  flags?: Partial<FeatureFlagDeps>;
}

export const defaultOrganizationFlagDeps: OrganizationFlagDeps = {};

/**
 * Whether a core switch is on for a subject. With `evaluate` (a test's stand-in for upstream's
 * vendor), it decides; a throw or no answer is off. Otherwise `featureEnabled`.
 */
export async function organizationFlagEnabled(
  flag: CoreFlag,
  subject: FlagSubject,
  deps: OrganizationFlagDeps = defaultOrganizationFlagDeps,
): Promise<boolean> {
  if (!deps.evaluate) return featureEnabled(flag, subject, deps.flags);
  const personProperties: Record<string, string> = {};
  if (subject.organizationId) personProperties.organization_id = subject.organizationId;
  if (subject.projectId) personProperties.project_id = subject.projectId;
  try {
    return (
      (await deps.evaluate(flag, subject.actor ?? `project:${subject.projectId ?? ""}`, {
        personProperties,
        sendFeatureFlagEvents: false,
      })) === true
    );
  } catch {
    return false;
  }
}
