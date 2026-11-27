import { getConfig } from "@/config";
import {
  checkUsageLimit,
  type UsageLimitsPort,
  type UsageLimitValues,
} from "@/lib/contracts/usage-limits";

/**
 * The core's usage limits: the same hard limits for every project, which an operator may lower
 * (`sandboxes.limits` in the configuration). The operator pays its own provider and models, so
 * usage is not recorded and no budget applies.
 */
export function createOssUsageLimits(values: () => UsageLimitValues): UsageLimitsPort {
  return {
    async limit(_subject, name) {
      return values()[name];
    },
    async check(_subject, name, request) {
      return checkUsageLimit(name, values()[name], request);
    },
    async record() {},
    async dailyBudgetUsd() {
      return null;
    },
  };
}

export const ossUsageLimits = createOssUsageLimits(() => getConfig().sandboxes.limits);
