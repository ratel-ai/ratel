import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { createDrizzleBaselineStore } from "./adapters/drizzle-baseline-store";
import { createDrizzleDatasetStore } from "./adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import type { BaselineKeyDeps } from "./baseline-api";
import { baselineApiDeps } from "./baseline-deps";
import { experimentsApiDeps } from "./experiment-deps";
import type { KeyAccess, KeyDeps } from "./experiments-api";
import { evalsEnabledForProject, evalsOffForAll } from "./gate";
import type { RunsApiDeps } from "./runs-api";

/** The routes of a project key, over the real key and database. */
export function keyExperimentDeps(request: Request, scope: ApiKeyScope): KeyDeps {
  return { ...experimentsApiDeps, ...keyAccess(request, scope) };
}

/** The routes of evals, runs and datasets for a project key. */
export function keyRunsDeps(request: Request, scope: ApiKeyScope): RunsApiDeps {
  return {
    ...keyExperimentDeps(request, scope),
    catalog: () => {
      const db = getDb();
      return {
        evals: createDrizzleEvalStore(db),
        datasets: createDrizzleDatasetStore(db),
        baselines: createDrizzleBaselineStore(db),
      };
    },
  };
}

export function keyBaselineDeps(request: Request, scope: ApiKeyScope): BaselineKeyDeps {
  return { ...baselineApiDeps, ...keyAccess(request, scope) };
}

function keyAccess(request: Request, scope: ApiKeyScope): KeyAccess {
  return {
    offForAll: () => evalsOffForAll(),
    authenticate: () => resolveProjectFromBearer(request, scope),
    enabled: (projectId) => evalsEnabledForProject(projectId),
    organizationIdOf: async (projectId) =>
      (await getOrganizationByProjectId(projectId))?.id ?? null,
  };
}
