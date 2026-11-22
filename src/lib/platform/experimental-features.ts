import { composition } from "@/lib/composition/ports";
import type { CoreFlag, FeatureFlagsPort, FlagSubject } from "@/lib/contracts/feature-flags";
import { flagEnvEnabled, parseFlagEnvValue } from "@/lib/platform/flags-env";

type Env = Readonly<Record<string, string | undefined>>;

/** What `featureEnabled` reads; the composition's by default, a test's own otherwise. */
export type FeatureFlagDeps = {
  env: Env;
  edition: string;
  port: FeatureFlagsPort | undefined;
};

/**
 * Whether a core switch is on for whoever asks. Without the edition's `featureFlags` port, it is
 * `experimentalFeatureEnabled`: the deployment's environment. With the port, an `FF_*` value set
 * in the environment comes first, either way; otherwise the edition decides for this subject,
 * and a failed read is off.
 */
export async function featureEnabled(
  flag: CoreFlag,
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const port = "port" in deps ? deps.port : composition.featureFlags;
  if (!port) return experimentalFeatureEnabled(flag, env, deps.edition ?? composition.edition);

  const forced = parseFlagEnvValue(env[flag]);
  if (forced !== undefined) return forced;
  try {
    return await port.enabled(flag, subject);
  } catch {
    return false;
  }
}

/**
 * Whether an experimental feature is on: its own `FF_*` flag, or, in the open-source edition,
 * `RATEL_EXPERIMENTAL_FEATURES`, the one switch for all of them. Cloud ignores the switch and
 * keeps per-feature control.
 */
export function experimentalFeatureEnabled(
  flag: string,
  env: Env = process.env,
  edition: string = composition.edition,
): boolean {
  if (flagEnvEnabled(env[flag])) return true;
  return edition === "Ratel OSS" && flagEnvEnabled(env.RATEL_EXPERIMENTAL_FEATURES);
}
