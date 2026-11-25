import type { Registration } from "@/lib/contracts/registry";
import { SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { enqueueJob } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { bundleStore } from "./adapters/bundle-store-from-env";
import { createDrizzleBuildStore } from "./adapters/drizzle-build-store";
import { sandboxProvider } from "./adapters/provider-from-env";
import { sandboxesEnabledForProject } from "./gate";
import { BUILD_STOPPED_MS, runImageBuild, STOPPED_REASON } from "./image-build-job";

/** A version that waits longer than this with no job was left by a process that ended. */
const UNQUEUED_MS = 2 * 60_000;

/**
 * What Ratel sandboxes contribute to the background machinery: the image build, which the reaper
 * spares while it sends heartbeats (it can outlast the stale-job window), and the sweeps that end
 * an interrupted build and queue a build that was never queued.
 */
export const sandboxesRegistration: Registration = {
  jobs: {
    [SANDBOX_IMAGE_BUILD_JOB]: (job) =>
      runImageBuild(job.projectId, job.payload, {
        builds: createDrizzleBuildStore(getDb()),
        bundles: bundleStore(),
        provider: sandboxProvider(),
        enabled: (projectId) => sandboxesEnabledForProject(projectId),
        now: () => new Date(),
        every: (ms, beat) => {
          const timer = setInterval(beat, ms);
          return () => clearInterval(timer);
        },
      }),
  },
  liveJobs: () => createDrizzleBuildStore(getDb()).liveJobIds(ago(BUILD_STOPPED_MS)),
  drainSteps: [
    {
      name: "sandbox_builds",
      phase: "before",
      run: async () => {
        const builds = createDrizzleBuildStore(getDb());
        const interruptedBuilds = await builds.failStopped(
          ago(BUILD_STOPPED_MS),
          STOPPED_REASON,
          new Date(),
        );
        const unqueued = await builds.listUnqueued(ago(UNQUEUED_MS));
        for (const { projectId, versionId } of unqueued) {
          await enqueueJob({ projectId, kind: SANDBOX_IMAGE_BUILD_JOB, payload: { versionId } });
        }
        return { interruptedBuilds, queuedBuilds: unqueued.length };
      },
    },
  ],
};

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}
