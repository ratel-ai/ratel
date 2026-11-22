import type { Registration } from "@/lib/contracts/registry";
import { getDb } from "@/lib/platform/db/client";
import { createPgSandboxRunStore, type SandboxDb } from "./adapters/pg-store";

/**
 * What the sandbox playground contributes to the background machinery: the drain's
 * `sandbox_run_events_prune` step (RC-1096), which deletes a run's event rows and commands
 * 7 days after the run ends. Run events are a replay buffer for live streams, not telemetry
 * the quality history needs, so the step is not retention-only: they expire whatever
 * `DATA_RETENTION_ENABLED` says. It keeps upstream's heartbeat key. No upstream counterpart:
 * upstream lists the step in its drain (`lib/cron/drain.ts`).
 */
export const sandboxesRegistration: Registration = {
  drainSteps: [
    {
      name: "sandbox_run_events_prune",
      phase: "after",
      run: async () => {
        const store = createPgSandboxRunStore(getDb() as unknown as SandboxDb);
        return { sandboxRunEventsPruned: await store.pruneExpiredEvents(new Date()) };
      },
    },
  ],
};
