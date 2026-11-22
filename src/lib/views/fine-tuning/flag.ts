import type { Organization } from "@/lib/contracts/session";
import {
  experimentalFeatureEnabled,
  type FeatureFlagDeps,
  featureEnabled,
} from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

/**
 * `FF_FINE_TUNING` (upstream's `cloud-fine-tuning`): the Fine-tuning page, its API routes, its
 * job and its MCP tools. Decided in the PROJECT's organization. Off, the page and the routes are
 * not found and the tools refuse.
 *
 * Owned (ADR-0030): a core switch, off by default. Without the edition's flags port it is one
 * switch for the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the
 * open-source edition); with it, the edition decides it for the organization and the person, or
 * for a caller with no session (MCP, the build job) by the project (`featureEnabled`). Upstream's
 * names stay, so every caller stays upstream's.
 */
export const FINE_TUNING_FLAG = "FF_FINE_TUNING" as const;

/** Where a failed decision of the rail goes: the log and the exception tracker. */
export interface FlagFailureDeps {
  logError: (fields: Record<string, unknown>, message: string) => void;
  report: (error: unknown, properties: Record<string, unknown>) => void;
}

const logger = getLogger("fine-tuning/flag");
const defaultFailureDeps: FlagFailureDeps = {
  logError: (fields, message) => logger.error(fields, message),
  report: (error, properties) => reportServerException(error, "system:fine-tuning", properties),
};

/**
 * The switch for the signed-in person in the project's organization. `actor` is the person's
 * identity-provider id, when the caller has it. Never throws: a failed decision is off.
 */
export function fineTuningEnabled(
  organization: Pick<Organization, "id">,
  deps: Partial<FeatureFlagDeps> = {},
  actor?: string,
): Promise<boolean> {
  return featureEnabled(
    FINE_TUNING_FLAG,
    { organizationId: organization.id, ...(actor ? { actor } : {}) },
    deps,
  );
}

/**
 * The switch for a caller with no session: an API key (`project:<id>`), an OAuth person (an
 * identity-provider id) or a system actor (`system:<name>`), decided with the project.
 */
export function fineTuningEnabledForActor(
  projectId: string,
  actor: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(FINE_TUNING_FLAG, { projectId, actor }, deps);
}

/**
 * With no database there is no organization to decide for: the deployment's environment. The
 * page asks it before it says the database is unavailable.
 */
export function fineTuningEnabledWithoutOrganization(
  env: Readonly<Record<string, string | undefined>> = process.env,
  edition?: string,
): boolean {
  return edition === undefined
    ? experimentalFeatureEnabled(FINE_TUNING_FLAG, env)
    : experimentalFeatureEnabled(FINE_TUNING_FLAG, env, edition);
}

/**
 * The rail's check (RC-1137): which of the person's organizations show Fine-tuning. A decision
 * that throws is off, logged and reported.
 */
export async function fineTuningOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  enabled: (organization: Pick<Organization, "id">) => Promise<boolean> = (organization) =>
    fineTuningEnabled(organization),
  failures: FlagFailureDeps = defaultFailureDeps,
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) => {
      try {
        return (await enabled(organization)) ? [organization.id] : [];
      } catch (err) {
        failures.logError(
          { err, organizationId: organization.id, flag_key: FINE_TUNING_FLAG },
          "fine tuning flag read failed",
        );
        failures.report(err, { component: "fine_tuning_flag", organization_id: organization.id });
        return [];
      }
    }),
  );
  return decided.flat();
}
