import { getConfig } from "@/config";
import { SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { enqueueJob } from "@/lib/jobs/queries";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { usageLimits } from "@/lib/platform/usage-limits";
import { recordPush } from "@/lib/views/repositories/push";
import { recordPushedCommit } from "@/lib/views/repositories/store";
import { bundleStore } from "./adapters/bundle-store-from-env";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import { sandboxProviderConfigured } from "./adapters/provider-from-env";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "./gate";
import type { PushApiDeps } from "./push-api";

/** The push API over the real database, tarball store and limits. */
export function pushApiDeps(req: Request, scope: ApiKeyScope): PushApiDeps {
  return {
    offForAll: sandboxesOffForAll,
    authenticate: () => resolveProjectFromBearer(req, scope),
    enabled: (projectId) => sandboxesEnabledForProject(projectId),
    organizationIdOf: async (projectId) =>
      (await getOrganizationByProjectId(projectId))?.id ?? null,
    versions: () => createDrizzleVersionStore(getDb()),
    bundles: bundleStore,
    limits: usageLimits,
    providerConfigured: () => sandboxProviderConfigured(),
    onUploaded: async ({ projectId, id, git, bundle }) => {
      await enqueueJob({ projectId, kind: SANDBOX_IMAGE_BUILD_JOB, payload: { versionId: id } });
      scheduleProjectDrain(projectId);
      await trackServerEvent(
        "sandbox_version_pushed",
        { projectId },
        {
          object_action: "sandbox_version_pushed",
          git_dirty: git?.dirty ?? null,
          bytes: bundle.bytes,
        },
      );
    },
    publicOrigin: () => getConfig().app.publicUrl || null,
    recordCommit: async (commit) => {
      await recordPush(commit, {
        enabled: (subject) => featureEnabled("githubRepositories", subject),
        recordPushedCommit: (row) => recordPushedCommit(row),
      });
    },
  };
}
