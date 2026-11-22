import { enqueueJob } from "@/lib/jobs/queries";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { getDb } from "@/lib/platform/db/client";
import { BUILD_DATASET_JOB, type DatasetBuildDeps } from "./build";
import { datasetBuildDeps } from "./build-deps";

/**
 * A dataset build started from a request (the console route, an MCP tool):
 * the job is queued and drained after the response, server-side; the cron
 * drain is the backstop. Only request paths import this file: it imports
 * `lib/jobs/route-helpers.ts`, which the job handlers must not (RC-189).
 */
export function requestBuildDeps(db = getDb()): DatasetBuildDeps {
  return {
    ...datasetBuildDeps(db),
    enqueue: async (projectId, payload) => {
      await enqueueJob({ projectId, kind: BUILD_DATASET_JOB, payload }, db);
      scheduleProjectDrain(projectId);
    },
  };
}
