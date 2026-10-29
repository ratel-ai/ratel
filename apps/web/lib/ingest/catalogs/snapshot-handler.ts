import type { resolveProjectFromBearer as resolveProjectFromBearerFn } from "@/lib/platform/api-key-bearer";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";
import type { replaceCatalogSnapshot as replaceCatalogSnapshotFn } from "./queries";
import { parseCatalogSnapshot } from "./snapshot";

export const MAX_CATALOG_SNAPSHOT_BYTES = 4_000_000;

export interface CatalogSnapshotHandlerDeps {
  resolveProjectFromBearer: typeof resolveProjectFromBearerFn;
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  replaceCatalogSnapshot: typeof replaceCatalogSnapshotFn;
  rateLimiter: TokenBucketRateLimiter;
  setRequestLogContext?: typeof setRequestLogContextFn;
  trackServerEvent?: typeof trackServerEventFn;
  logError?: LogError;
  reportServerException?: typeof reportServerException;
}

const logger = getLogger("catalogs/snapshot-handler");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/** API-key-authenticated full catalog replacement for one runtime source. */
export async function handleCatalogSnapshotRequest(
  request: Request,
  deps: CatalogSnapshotHandlerDeps,
): Promise<Response> {
  if (!isJson(request.headers.get("content-type"))) {
    return json({ error: "Unsupported Content-Type. Send application/json." }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_SNAPSHOT_BYTES) {
    return tooLarge();
  }

  const resolved = await deps.resolveProjectFromBearer(request);
  if (!resolved.ok) return resolved.response;
  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext?.(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  // Throttle before the flag check: the flag-off path is exactly the one a
  // hot-looping SDK retries against, so it must consume the same token bucket.
  const rateLimit = deps.rateLimiter.consume(resolved.apiKeyId);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const read = await readBodyWithCap(request, MAX_CATALOG_SNAPSHOT_BYTES);
  if (!read.ok) return tooLarge();

  let snapshot: ReturnType<typeof parseCatalogSnapshot>;
  try {
    snapshot = parseCatalogSnapshot(JSON.parse(new TextDecoder().decode(read.bytes)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid snapshot";
    return json({ error: `Malformed catalog snapshot: ${message}.` }, 400);
  }

  try {
    const result = await deps.replaceCatalogSnapshot(resolved.projectId, snapshot);
    await deps.trackServerEvent?.(
      "catalog_snapshot_synced",
      {
        projectId: resolved.projectId,
        ...(organization ? { orgId: organization.id } : {}),
      },
      {
        object_action: "catalog_snapshot_synced",
        source_id: snapshot.sourceId,
        tool_count: snapshot.tools.length,
        // How many tools separated their retrieval text from their agent text.
        // Zero on a publisher that has not adopted the field, which is the
        // signal that a re-sync would collapse both roles onto one string.
        searchable_description_count: snapshot.tools.filter(
          (tool) => tool.searchableDescription !== undefined,
        ).length,
        unchanged: !result.changed,
      },
    );
    return Response.json(
      {
        sourceId: snapshot.sourceId,
        catalogVersion: snapshot.hash,
        tools: snapshot.tools.length,
        unchanged: !result.changed,
      },
      { headers: { ETag: snapshot.etag, "Cache-Control": "no-cache" } },
    );
  } catch (error) {
    (deps.logError ?? defaultLogError)("catalog snapshot sync failed", error, {
      project_id: resolved.projectId,
      source_id: snapshot.sourceId,
    });
    (deps.reportServerException ?? reportServerException)(error, `project:${resolved.projectId}`, {
      endpoint: "/api/v1/catalog/snapshot",
      source_id: snapshot.sourceId,
    });
    return json({ error: "Failed to store catalog snapshot." }, 500);
  }
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function tooLarge(): Response {
  return json({ error: `Request body too large (max ${MAX_CATALOG_SNAPSHOT_BYTES} bytes).` }, 413);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
