import { getConfig } from "@/config";
import type { UsageLimitValues } from "./usage-limits";

/**
 * The limits of this deployment: the `SANDBOX_*` settings, each at most its hard limit, else the
 * defaults (`SANDBOX_DEFAULT_LIMITS`). An edition's usage limits start from these values, so the
 * settings of `web/.env.example` hold in each edition. Apart from `usage-limits.ts`, because the
 * configuration imports the hard limits from there.
 */
export function configuredSandboxLimits(): UsageLimitValues {
  return getConfig().sandboxes.limits;
}
