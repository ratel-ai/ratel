import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import type { BaselineKeyDeps } from "./baseline-api";
import { baselineApiDeps } from "./baseline-deps";
import { readOnlyTools } from "./console-deps";
import { caseFromTurn } from "./domain/from-turn";
import { experimentDeps, experimentsApiDeps } from "./experiment-deps";
import type { KeyAccess, KeyDeps } from "./experiments-api";
import { evalsEnabledForProject, evalsOffForAll } from "./gate";
import type { ModelApiDeps } from "./model-api";
import { evalsServiceDeps } from "./service-deps";
import { loadTurnContent } from "./turn-content";

/** The routes of a project key, over the real key and database. */
export function keyExperimentDeps(request: Request, scope: ApiKeyScope): KeyDeps {
  return { ...experimentsApiDeps, ...keyAccess(request, scope) };
}

export function keyBaselineDeps(request: Request, scope: ApiKeyScope): BaselineKeyDeps {
  return { ...baselineApiDeps, ...keyAccess(request, scope) };
}

/** The routes of a project key for datasets, evals, the library and runs of one eval. */
export function keyModelDeps(request: Request, scope: ApiKeyScope): ModelApiDeps {
  return {
    ...keyAccess(request, scope),
    service: evalsServiceDeps,
    experiments: experimentDeps,
    advance: experimentsApiDeps.advance,
    track: (experiment, by) => experimentsApiDeps.track(experiment, by),
    publicUrl: experimentsApiDeps.publicUrl,
    readContent: (projectId) => contentOptIn(projectId),
    turnRow: async (projectId, turnId) => {
      const turn = await loadTurnContent(projectId, turnId);
      return turn ? caseFromTurn(turn, await readOnlyTools(projectId)) : null;
    },
  };
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
