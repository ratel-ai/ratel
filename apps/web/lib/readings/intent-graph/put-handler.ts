import type { resolveProjectFromBearer as resolveProjectFromBearerFn } from "@/lib/platform/api-key-bearer";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";
import type { putIntentGraph as putIntentGraphFn } from "@/lib/readings/intent-graph/queries";
import {
  intentGraphContentHash,
  isCloudGraphKey,
  MAX_INTENT_GRAPH_BYTES,
  parseIntentGraphPutBody,
} from "@/lib/readings/intent-types/wire";

export interface IntentGraphPutHandlerDeps {
  resolveProjectFromBearer: typeof resolveProjectFromBearerFn;
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  putIntentGraph: typeof putIntentGraphFn;
  rateLimiter: TokenBucketRateLimiter;
  setRequestLogContext?: typeof setRequestLogContextFn;
  trackServerEvent?: typeof trackServerEventFn;
  logError?: LogError;
  reportServerException?: typeof reportServerException;
}

const logger = getLogger("intent-graph/put-handler");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

export const INTENT_GRAPH_ENDPOINT = "/api/v1/intent-graph";

/**
 * `PUT /api/v1/intent-graph`: store a runtime's adaptive-ranking intent graph
 * under (project, source_id). Bearer project key. Error bodies carry machine
 * codes in `error`, never sentences, and never any part of the graph.
 */
export async function handleIntentGraphPut(
  request: Request,
  deps: IntentGraphPutHandlerDeps,
): Promise<Response> {
  if (!isJson(request.headers.get("content-type"))) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INTENT_GRAPH_BYTES) {
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
  // hot-looping client retries against, so it must consume the same bucket.
  const rateLimit = deps.rateLimiter.consume(resolved.apiKeyId);
  if (!rateLimit.allowed) {
    return json({ error: "rate_limited" }, 429, {
      "Retry-After": String(rateLimit.retryAfterSeconds),
    });
  }

  const read = await readBodyWithCap(request, MAX_INTENT_GRAPH_BYTES);
  if (!read.ok) return tooLarge();

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = parseIntentGraphPutBody(raw);
  if (!parsed.ok) return json({ error: "invalid_graph", details: parsed.details }, 400);

  const { sourceId, graph } = parsed;
  // The Cloud-side builder's key. A runtime pushing under it would overwrite
  // the graph Cloud learned from the whole fleet, so it is refused outright,
  // with its own code so a client can tell it from a malformed document.
  if (isCloudGraphKey(sourceId)) return json({ error: "reserved_key" }, 400);
  const clusterCount = graph.intents.length;
  try {
    const result = await deps.putIntentGraph({
      projectId: resolved.projectId,
      sourceId,
      graph,
      contentHash: intentGraphContentHash(graph),
      byteSize: read.bytes.byteLength,
      ifMatch: request.headers.get("if-match"),
    });
    if (result.outcome === "stale") {
      return json({ error: "stale_graph", rev: result.rev, etag: result.etag }, 409, {
        ETag: result.etag,
      });
    }
    await deps.trackServerEvent?.(
      "intent_graph_synced",
      {
        projectId: resolved.projectId,
        ...(organization ? { orgId: organization.id } : {}),
      },
      {
        object_action: "intent_graph_synced",
        source_id: sourceId,
        cluster_count: clusterCount,
        byte_size: read.bytes.byteLength,
        rev: result.rev,
        unchanged: result.outcome === "unchanged",
        has_model: graph.model !== undefined,
      },
    );
    return json({ sourceId, rev: result.rev, unchanged: result.outcome === "unchanged" }, 200, {
      ETag: result.etag,
      "Cache-Control": "no-cache",
    });
  } catch (error) {
    // Structured fields only: never the body, never a member.
    (deps.logError ?? defaultLogError)("intent graph sync failed", error, {
      project_id: resolved.projectId,
      source_id: sourceId,
      cluster_count: clusterCount,
    });
    (deps.reportServerException ?? reportServerException)(error, `project:${resolved.projectId}`, {
      endpoint: INTENT_GRAPH_ENDPOINT,
      source_id: sourceId,
    });
    return json({ error: "internal_error" }, 500);
  }
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function tooLarge(): Response {
  return json({ error: "payload_too_large", max_bytes: MAX_INTENT_GRAPH_BYTES }, 413);
}

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, headers ? { status, headers } : { status });
}
