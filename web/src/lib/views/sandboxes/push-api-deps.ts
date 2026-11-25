import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { publicUrl } from "@/lib/platform/public-url";
import { usageLimits } from "@/lib/platform/usage-limits";
import { bundleStore } from "./adapters/bundle-store-from-env";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "./gate";
import type { PushApiDeps } from "./push-api";

/** The push API over the real database, bundle store and limits. */
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
    providerConfigured: () => false,
    onUploaded: async () => {},
    publicUrl,
  };
}
