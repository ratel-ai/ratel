import { findProjectScope } from "@/lib/console/scope/project-scope";
import { traceRawResponse } from "@/lib/ingest/otlp-raw/trace-raw-route";
import { readTraceRawRequests, readTraceRawSpans } from "@/lib/ingest/otlp-raw/trace-read";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { payloadContentEnabledForActor } from "@/lib/synthesis/traces/payload-content";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";
import { contentOptIn } from "@/lib/views/session-replay/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One run's raw spans for the span pane, or `?format=otlp` as a file (RC-412). A read; no product
 * event. Owned (ADR-0030): one organization per session, so the project must be one of its
 * projects (`findProjectScope` takes the project id only).
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string; traceId: string }> },
): Promise<Response> {
  const params = await context.params;
  if (!isDbConfigured()) {
    return Response.json({ ok: false, message: "This run isn't available." }, { status: 404 });
  }
  return traceRawResponse(request, params, {
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    findProject: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { projectId: scope.project.id } : null;
    },
    flagEnabled: traceViewsV3EnabledForActor,
    contentEnabled: payloadContentEnabledForActor,
    readContent: (projectId) =>
      withStatementTimeout((db) => contentOptIn(projectId, db), {
        operation: "trace_raw_read_content",
      }),
    loadRaw: (projectId, traceId) =>
      withStatementTimeout((db) => readTraceRawSpans(db, { projectId, traceId }), {
        operation: "trace_raw",
      }),
    loadRawOtlp: (projectId, traceId) =>
      withStatementTimeout((db) => readTraceRawRequests(db, { projectId, traceId }), {
        operation: "trace_raw_otlp",
      }),
    setLogContext: (fields) => setRequestLogContext(request, fields),
  });
}
