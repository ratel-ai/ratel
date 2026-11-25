import { type InternalConfig, refuseInternalRequest } from "@/lib/platform/internal-auth/bearer";
import { getLogger } from "@/lib/platform/logger";
import { invalidateHolds } from "./state";
import {
  clearHold,
  type HoldScope,
  type HoldStatus,
  holdStatus,
  projectsOfScope,
  setHold,
} from "./store";

/** `/api/internal/holds` (docs/internal-api.md): set, lift and read a hold, with the internal secret. */
export interface HoldsRouteDeps {
  config?: InternalConfig;
  isDbConfigured: () => boolean;
  /** Whether the edition knows the organization. */
  organizationExists: (organizationId: string) => Promise<boolean>;
  projectsOfScope: (scope: HoldScope) => Promise<string[] | null>;
  setHold: (scope: HoldScope) => Promise<void>;
  clearHold: (scope: HoldScope) => Promise<number>;
  holdStatus: (scope: HoldScope, projectIds: string[]) => Promise<HoldStatus>;
  invalidate: () => void;
  /** Start the jobs that waited, once a hold is lifted. */
  startJobs: (projectId: string) => void;
}

export const storedHolds: Pick<
  HoldsRouteDeps,
  "projectsOfScope" | "setHold" | "clearHold" | "holdStatus" | "invalidate"
> = {
  projectsOfScope: (scope) => projectsOfScope(scope),
  setHold: (scope) => setHold(scope),
  clearHold: (scope) => clearHold(scope),
  holdStatus: (scope, projectIds) => holdStatus(scope, projectIds),
  invalidate: invalidateHolds,
};

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const logger = getLogger("platform/org-hold");

export async function handleHoldsPost(request: Request, deps: HoldsRouteDeps): Promise<Response> {
  const refusal = refuseInternalRequest(request, deps.config);
  if (refusal) return refusal;
  let body: { action?: unknown; organizationId?: unknown; projectIds?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }
  const action = body?.action;
  const scope = readScope(body?.organizationId, body?.projectIds);
  if ((action !== "hold" && action !== "clear") || !scope) return badRequest();
  return answer(scope, deps, async (projectIds) => {
    if (action === "hold") {
      await deps.setHold(scope);
      deps.invalidate();
    } else {
      const lifted = await deps.clearHold(scope);
      deps.invalidate();
      if (lifted > 0) for (const projectId of projectIds) deps.startJobs(projectId);
    }
    logger.info({ ...scopeFields(scope), action }, "organization hold changed");
  });
}

export async function handleHoldsGet(request: Request, deps: HoldsRouteDeps): Promise<Response> {
  const refusal = refuseInternalRequest(request, deps.config);
  if (refusal) return refusal;
  const params = new URL(request.url).searchParams;
  const projectIds = params.getAll("projectId");
  const scope = readScope(
    params.get("organizationId") ?? undefined,
    projectIds.length > 0 ? projectIds : undefined,
  );
  return scope ? answer(scope, deps) : badRequest();
}

async function answer(
  scope: HoldScope,
  deps: HoldsRouteDeps,
  change: (projectIds: string[]) => Promise<void> = async () => {},
): Promise<Response> {
  if (!deps.isDbConfigured()) return unavailable();
  try {
    const known =
      scope.kind === "projects" || (await deps.organizationExists(scope.organizationId));
    const projectIds = known ? await deps.projectsOfScope(scope) : null;
    if (!projectIds) {
      return Response.json({ error: "Unknown organization or project." }, { status: 404 });
    }
    await change(projectIds);
    return Response.json(await deps.holdStatus(scope, projectIds));
  } catch (err) {
    logger.error({ err, ...scopeFields(scope) }, "organization hold request failed");
    return unavailable();
  }
}

function readScope(organizationId: unknown, projectIds: unknown): HoldScope | null {
  if (organizationId !== undefined && projectIds !== undefined) return null;
  if (typeof organizationId === "string" && UUID.test(organizationId)) {
    return { kind: "organization", organizationId };
  }
  if (
    Array.isArray(projectIds) &&
    projectIds.length > 0 &&
    projectIds.every((id) => typeof id === "string" && UUID.test(id))
  ) {
    return { kind: "projects", projectIds: projectIds as string[] };
  }
  return null;
}

function scopeFields(scope: HoldScope): Record<string, unknown> {
  return scope.kind === "organization"
    ? { org_id: scope.organizationId }
    : { project_ids: scope.projectIds };
}

function badRequest(): Response {
  return Response.json(
    {
      error: "Send an action (hold or clear) and one organizationId or a list of projectIds.",
    },
    { status: 400 },
  );
}

function unavailable(): Response {
  return Response.json(
    { error: "Not available. Try again." },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}
