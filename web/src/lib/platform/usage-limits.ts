import { ossUsageLimits } from "@/lib/adapters/oss/usage-limits";
import { composition } from "@/lib/composition/ports";
import type { UsageLimitsPort } from "@/lib/contracts/usage-limits";

/** The edition's usage limits, else the core's. */
export function usageLimits(): UsageLimitsPort {
  return composition.usageLimits ?? ossUsageLimits;
}
