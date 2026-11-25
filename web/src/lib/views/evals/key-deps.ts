import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { experimentsApiDeps } from "./experiment-deps";
import type { KeyDeps } from "./experiments-api";
import { evalsEnabledForProject, evalsOffForAll } from "./gate";

/** The routes of a project key, over the real key and database. */
export function keyExperimentDeps(request: Request, scope: ApiKeyScope): KeyDeps {
  return {
    ...experimentsApiDeps,
    offForAll: () => evalsOffForAll(),
    authenticate: () => resolveProjectFromBearer(request, scope),
    enabled: (projectId) => evalsEnabledForProject(projectId),
    organizationIdOf: async (projectId) =>
      (await getOrganizationByProjectId(projectId))?.id ?? null,
  };
}
