import { ifNoneMatchMatches } from "@/lib/catalog/wire";
import type { resolveProjectFromBearer as resolveProjectFromBearerFn } from "@/lib/platform/api-key-bearer";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import type {
  getIntentGraph as getIntentGraphFn,
  touchIntentGraphPull as touchIntentGraphPullFn,
} from "@/lib/readings/intent-graph/queries";
import { intentGraphEtag } from "@/lib/readings/intent-types/wire";

export interface IntentGraphGetHandlerDeps {
  resolveProjectFromBearer: typeof resolveProjectFromBearerFn;
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  getIntentGraph: typeof getIntentGraphFn;
  touchIntentGraphPull: typeof touchIntentGraphPullFn;
  rateLimiter: TokenBucketRateLimiter;
  // Optional so existing callers and tests are untouched; absent means no
  // graph is ever served under a foreign key.
  setRequestLogContext?: typeof setRequestLogContextFn;
  trackServerEvent?: typeof trackServerEventFn;
  logError?: LogError;
}

const logger = getLogger("intent-graph/get-handler");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/**
 * `GET /api/v1/intent-graph?source=<source_id>`: return a runtime's stored graph
 * with a strong ETag and conditional-GET semantics. The pull is recorded before
 * the 200/304 decision, because it is the only positive evidence that a graph we
 * store actually reaches a runtime.
 */
export async function handleIntentGraphGet(
  request: Request,
  deps: IntentGraphGetHandlerDeps,
): Promise<Response> {
  const resolved = await deps.resolveProjectFromBearer(request);
  if (!resolved.ok) return resolved.response;
  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext?.(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  const rateLimit = deps.rateLimiter.consume(resolved.apiKeyId);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const source = new URL(request.url).searchParams.get("source")?.trim() ?? "";
  if (source.length === 0) {
    return Response.json(
      { error: "invalid_request", details: ["source query parameter is required"] },
      { status: 400 },
    );
  }

  // A key names exactly one stored graph: a runtime's own, or one Cloud built
  // ("cloud", "cloud/<source>"). Cloud never decides whether a runtime ranks
  // from a graph: the runtime does, by pulling it and enabling ranking in its
  // own code. Cloud only records that it did.
  try {
    await deps.touchIntentGraphPull(resolved.projectId, undefined, undefined, source);
  } catch (error) {
    (deps.logError ?? defaultLogError)("recording the intent graph pull failed", error, {
      project_id: resolved.projectId,
      source_id: source,
      graph_key: source,
    });
  }

  const row = await deps.getIntentGraph(resolved.projectId, source);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  const etag = intentGraphEtag(row.contentHash);
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  await deps.trackServerEvent?.(
    "intent_graph_pulled",
    {
      projectId: resolved.projectId,
      ...(organization ? { orgId: organization.id } : {}),
    },
    {
      object_action: "intent_graph_pulled",
      source_id: source,
      graph_key: source,
      rev: row.rev,
      cluster_count: row.clusterCount,
    },
  );
  return Response.json(
    { sourceId: source, graphKey: source, rev: row.rev, graph: row.document },
    { headers },
  );
}
