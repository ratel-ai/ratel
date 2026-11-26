import { getConfig } from "@/config";
import type { Registration } from "@/lib/contracts/registry";
import { SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { enqueueJob } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { usageLimits } from "@/lib/platform/usage-limits";
import { bundleStore } from "./adapters/bundle-store-from-env";
import { createDrizzleBuildStore } from "./adapters/drizzle-build-store";
import { createDrizzleSecretStore } from "./adapters/drizzle-secret-store";
import { createDrizzleVmStore } from "./adapters/drizzle-vm-store";
import { sandboxProvider } from "./adapters/provider-from-env";
import { sandboxesEnabledForProject } from "./gate";
import { BUILD_STOPPED_MS, runImageBuild, STOPPED_REASON } from "./image-build-job";
import { runDeps } from "./run-deps";
import { sweepRuns } from "./run-sweep";

/** A version that waits longer than this with no job was left by a process that ended. */
const UNQUEUED_MS = 2 * 60_000;

/**
 * What Ratel sandboxes contribute to the background machinery: the image preparation, which the reaper
 * spares while it sends heartbeats (it can outlast the stale-job window), and the sweeps that end
 * an interrupted build, queue a build that was never queued, end the runs that their process left,
 * and delete the run VMs that are idle or unknown.
 */
export const sandboxesRegistration: Registration = {
  jobs: {
    [SANDBOX_IMAGE_BUILD_JOB]: (job) =>
      runImageBuild(job.projectId, job.payload, {
        builds: createDrizzleBuildStore(getDb()),
        bundles: bundleStore(),
        provider: sandboxProvider(),
        secrets: createDrizzleSecretStore(getDb()),
        vms: createDrizzleVmStore(getDb()),
        limits: usageLimits(),
        organizationIdOf: async (projectId) =>
          (await getOrganizationByProjectId(projectId))?.id ?? null,
        callbackUrl: () => getConfig().sandboxes.callbackUrl ?? publicBaseUrl(),
        sealingKey: () => sealedSecretsKey(),
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
    {
      name: "sandbox_runs",
      phase: "before",
      run: () =>
        sweepRuns({
          ...runDeps(),
          idleMs: getConfig().sandboxes.vmIdleSeconds * 1000,
          organizationIdOf: async (projectId) =>
            (await getOrganizationByProjectId(projectId))?.id ?? null,
        }),
    },
  ],
};

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}
