import type { Registration } from "@/lib/contracts/registry";
import { pruneExpiredRuntimeEventRejects, pruneExpiredRuntimeEvents } from "./maintenance";

/**
 * What runtime-event ingest contributes to the drain: the two retention passes, one
 * bounded batch each per tick, run only when the operator has turned retention deletion
 * on. The step results keep upstream's heartbeat keys.
 */
export const ingestTraceEventsRegistration: Registration = {
  drainSteps: [
    {
      name: "runtime_events_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ runtimeEventsPruned: await pruneExpiredRuntimeEvents() }),
    },
    {
      name: "runtime_event_rejects_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ runtimeEventRejectsPruned: await pruneExpiredRuntimeEventRejects() }),
    },
  ],
};
