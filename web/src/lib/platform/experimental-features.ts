import { type Config, getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { CoreFlag, FeatureFlagsPort, FlagSubject } from "@/lib/contracts/feature-flags";

/** The settings a flag reads (`web/src/config.ts`): its forced value, and `experimentalFeatures`. */
export type FlagConfig = Pick<Config, "flags" | "experimentalFeatures">;

/** What `featureEnabled` reads; the composition's by default, a test's own otherwise. */
export type FeatureFlagDeps = {
  config: FlagConfig;
  edition: string;
  port: FeatureFlagsPort | undefined;
};

/**
 * Whether a core switch is on for whoever asks. Without the edition's `featureFlags` port, it is
 * `experimentalFeatureEnabled`: the deployment's configuration. With the port, a value the
 * configuration forces comes first, either way; otherwise the edition decides for this subject,
 * and a failed read is off.
 */
export async function featureEnabled(
  flag: CoreFlag,
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  const config = deps.config ?? getConfig();
  const port = "port" in deps ? deps.port : composition.featureFlags;
  if (!port) return experimentalFeatureEnabled(flag, config, deps.edition ?? composition.edition);

  const forced = config.flags[flag];
  if (forced !== undefined) return forced;
  try {
    return await port.enabled(flag, subject);
  } catch {
    return false;
  }
}

/** The organizations a per-organization decision is on for. A failed decision counts as off. */
export async function organizationIdsWith<O extends { id: string }>(
  organizations: readonly O[],
  enabled: (organization: O) => Promise<boolean>,
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await enabled(organization).catch(() => false)) ? [organization.id] : [],
    ),
  );
  return decided.flat();
}

/**
 * Whether an experimental feature is on: its own flag, or, in the open-source edition,
 * `experimentalFeatures`, the one switch for all of them. Cloud ignores the switch and keeps
 * per-feature control.
 */
export function experimentalFeatureEnabled(
  flag: CoreFlag,
  config: FlagConfig = getConfig(),
  edition: string = composition.edition,
): boolean {
  if (config.flags[flag] === true) return true;
  return edition === "Ratel OSS" && config.experimentalFeatures;
}

/** Whether the switch is off for every project, known with no project: a route can answer 404 first. */
export function featureOffForAll(flag: CoreFlag, deps: Partial<FeatureFlagDeps> = {}): boolean {
  const config = deps.config ?? getConfig();
  if (config.flags[flag] === false) return true;
  const port = "port" in deps ? deps.port : composition.featureFlags;
  return !port && !experimentalFeatureEnabled(flag, config, deps.edition);
}

/** The organizations that have the switch on. A failed decision is off. */
export async function organizationIdsWithFeature(
  flag: CoreFlag,
  organizations: ReadonlyArray<{ id: string }>,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async ({ id }) =>
      (await featureEnabled(flag, { organizationId: id }, deps)) ? [id] : [],
    ),
  );
  return decided.flat();
}
