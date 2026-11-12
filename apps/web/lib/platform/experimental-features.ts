import { composition } from "@/lib/composition/ports";
import { flagEnvEnabled } from "@/lib/platform/flags-env";

/**
 * Whether an experimental feature is on: its own `FF_*` flag, or, in the open-source edition,
 * `RATEL_EXPERIMENTAL_FEATURES`, the one switch for all of them. Cloud ignores the switch and
 * keeps per-feature control.
 */
export function experimentalFeatureEnabled(
  flag: string,
  env: Record<string, string | undefined> = process.env,
  edition: string = composition.edition,
): boolean {
  if (flagEnvEnabled(env[flag])) return true;
  return edition === "Ratel OSS" && flagEnvEnabled(env.RATEL_EXPERIMENTAL_FEATURES);
}
