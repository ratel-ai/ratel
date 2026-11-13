import type { Registration } from "@/lib/contracts/registry";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import { runIntentEngine } from "./job";
import { enqueueDueIntentEngineRuns, expireIntentEngineClusters } from "./jobs";

/**
 * The intent engine's registration: the `cluster_intents` job (a project's new asks
 * clustered, levelled and, with a model key, named), the drain's safety-net enqueue of it,
 * and the retention step that forgets level-0 clusters whose last ask is older than event
 * retention. The step results keep upstream's heartbeat keys.
 */
export const intentEngineRegistration: Registration = {
  // In the project's log context, so `model_call` lines carry the project and organization.
  jobs: {
    cluster_intents: (job) =>
      withProjectLogContext(job.projectId, () => runIntentEngine(job.projectId)),
  },
  drainSteps: [
    {
      name: "intent_engine_enqueue",
      phase: "before",
      run: async () => ({
        intentEngineRunsEnqueued: (await enqueueDueIntentEngineRuns()).enqueued,
      }),
    },
    {
      name: "intent_engine_expire",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ intentEngineClustersExpired: await expireIntentEngineClusters() }),
    },
  ],
};
