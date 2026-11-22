import { createHash } from "node:crypto";
import { ifNoneMatchMatches } from "@/lib/catalog/wire";
import type {
  listRuntimeCatalogOverrides,
  touchRuntimeCatalogOverridesPull,
} from "@/lib/ingest/runtime-catalog/override-queries";
import type { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getLogger } from "@/lib/platform/logger";
import type { getOrganizationByProjectId } from "@/lib/platform/organizations";
import type { setRequestLogContext } from "@/lib/platform/request-log";

/**
 * The bearer half of runtime catalog overrides, split from the session-only
 * PATCH (`override-handler.ts`) so a route that serves only the operator edit
 * never imports a key-authenticated handler.
 */

const overridesLogger = getLogger("runtime-catalog/override-handler");

/** The bearer pull view. */
export interface RuntimeCatalogOverridesGetDeps {
  /** The scope this route needs (`BEARER_ROUTE_SCOPES`). */
  scope: ApiKeyScope;
  resolveProjectFromBearer: typeof resolveProjectFromBearer;
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  listRuntimeCatalogOverrides: typeof listRuntimeCatalogOverrides;
  touchRuntimeCatalogOverridesPull: typeof touchRuntimeCatalogOverridesPull;
  setRequestLogContext: typeof setRequestLogContext;
}

/** Bearer-authenticated pull view for Cloud-side runtime overrides. */
export async function handleRuntimeCatalogOverridesGet(
  request: Request,
  deps: RuntimeCatalogOverridesGetDeps,
): Promise<Response> {
  const resolved = await deps.resolveProjectFromBearer(request, deps.scope);
  if (!resolved.ok) return resolved.response;

  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  // The pull itself is the only positive evidence that an override we store
  // actually reaches a runtime, so record it before deciding whether to answer
  // 304: a conditional request proves the runtime is listening just as well as
  // a 200, and it is the overwhelmingly common case. Best-effort, because
  // failing to note the visit must never fail the visit.
  try {
    await deps.touchRuntimeCatalogOverridesPull(resolved.projectId);
  } catch (error) {
    overridesLogger.error(
      { err: error, project_id: resolved.projectId },
      "recording the override pull failed",
    );
  }

  const payload = {
    overrides: await deps.listRuntimeCatalogOverrides(resolved.projectId),
  };
  const etag = `"${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}"`;
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(payload, { headers });
}
