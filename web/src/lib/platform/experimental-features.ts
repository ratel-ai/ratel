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
