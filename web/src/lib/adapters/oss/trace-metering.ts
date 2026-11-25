import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";

/** No meters in the open-source edition: every trace is stored and analyzed. */
export const ossTraceMetering: TraceMeteringPort = {
  async isMetered() {
    return false;
  },
  async meterTraceBatch(_scope, spansByTrace) {
    return new Map([...spansByTrace.keys()].map((id) => [id, "analyzed"]));
  },
};
