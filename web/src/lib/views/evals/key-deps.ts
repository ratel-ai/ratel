import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import type { BaselineKeyDeps } from "./baseline-api";
import { baselineApiDeps } from "./baseline-deps";
import { experimentsApiDeps } from "./experiment-deps";
import type { KeyAccess, KeyDeps } from "./experiments-api";

/** The routes of a project key, over the real key and database. */
export function keyExperimentDeps(request: Request, scope: ApiKeyScope): KeyDeps {
  return { ...experimentsApiDeps, ...keyAccess(request, scope) };
}

export function keyBaselineDeps(request: Request, scope: ApiKeyScope): BaselineKeyDeps {
  return { ...baselineApiDeps, ...keyAccess(request, scope) };
}

function keyAccess(request: Request, scope: ApiKeyScope): KeyAccess {
  return {
    authenticate: () => resolveProjectFromBearer(request, scope),
    organizationIdOf: async (projectId) =>
      (await getOrganizationByProjectId(projectId))?.id ?? null,
  };
}
