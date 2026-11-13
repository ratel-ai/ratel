import type { Registration } from "@/lib/contracts/registry";
import { enqueueDueIntentGraphFolds, foldProjectIntentGraph, foldSeams } from "./fold-job";
import {
  expireIntentGraphClusterMembers,
  pruneIntentGraphRevisions,
  pruneIntentGraphShadowTurns,
} from "./maintenance";

/**
 * The intent graph's registration: the `fold_intent_graph` job (a project's stored runtime
 * events folded into its Cloud-built graphs), the drain's safety-net enqueue of it, and one
 * retention step for the derived tables: old revisions and shadow rows past retention, and
 * the clusters of Cloud-built graphs unobserved past event retention, whose members are raw
 * asks. The step results keep upstream's heartbeat keys.
 */
export const intentGraphRegistration: Registration = {
  jobs: {
    fold_intent_graph: (job) => foldProjectIntentGraph(job.projectId, foldSeams),
  },
  drainSteps: [
    {
      name: "intent_graph_fold_enqueue",
      phase: "before",
      run: async () => ({
        intentGraphFoldsEnqueued: (await enqueueDueIntentGraphFolds()).enqueued,
      }),
    },
    {
      name: "intent_graph_revisions_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => {
        const revisions = await pruneIntentGraphRevisions();
        const shadowTurns = await pruneIntentGraphShadowTurns();
        const expired = await expireIntentGraphClusterMembers();
        return { intentGraphRevisionsPruned: revisions + shadowTurns + expired.clusters };
      },
    },
  ],
};
