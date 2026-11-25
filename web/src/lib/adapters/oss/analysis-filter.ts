import type { AnalysisFilterPort } from "@/lib/contracts/analysis-filter";

/** Every stored trace is analyzed in the open-source edition, so nothing is filtered. */
export const ossAnalysisFilter: AnalysisFilterPort = {
  async analyzedTraceCondition() {
    return undefined;
  },
};
