import type { Logger } from "pino";
import { getLogger, runWithLogContext, setLogContext } from "@/lib/platform/logger";
import { annotateActiveSpan, type SpanEnrichmentContext } from "@/lib/platform/otel/enrich";
import {
  type LookupProjectLabels,
  lookupProjectLabels,
  type ProjectLabels,
} from "@/lib/platform/request-log-labels";

type RouteHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

export type RequestLogContext = SpanEnrichmentContext & {
  distinct_id?: string;
};

type AnnotateSpan = (context: SpanEnrichmentContext) => void;
type RequestLogger = Pick<Logger, "error" | "info">;

const requestLogContexts = new WeakMap<Request, RequestLogContext>();
const requestLogger = getLogger("request-log");

export function withRequestLog<Args extends unknown[]>(
  handler: RouteHandler<Args>,
  logger: RequestLogger = requestLogger,
  lookupLabels: LookupProjectLabels = lookupProjectLabels,
): RouteHandler<Args> {
  return async (request, ...args) => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return runWithLogContext({ requestId }, async () => {
      const startedAt = performance.now();
      let response: Response;

      try {
        response = await handler(request, ...args);
      } catch (error) {
        await logRequest(request, requestId, 500, startedAt, logger, lookupLabels);
        throw error;
      }

      try {
        response.headers.set("x-request-id", requestId);
      } catch {
        const headers = new Headers(response.headers);
        headers.set("x-request-id", requestId);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      await logRequest(request, requestId, response.status, startedAt, logger, lookupLabels);

      return response;
    });
  };
}

export function setRequestLogContext(
  request: Request,
  context: RequestLogContext,
  annotateSpan: AnnotateSpan = annotateActiveSpan,
): void {
  const mergedContext = { ...requestLogContexts.get(request), ...context };
  requestLogContexts.set(request, mergedContext);
  const spanContext = toSpanContext(mergedContext);
  setLogContext(spanContext);
  annotateSpan(spanContext);
}

async function logRequest(
  request: Request,
  requestId: string,
  status: number,
  startedAt: number,
  logger: RequestLogger,
  lookupLabels: LookupProjectLabels,
): Promise<void> {
  const durationMs = Math.round(performance.now() - startedAt);
  const projectId = requestLogContexts.get(request)?.project_id;
  requestLogContexts.delete(request);
  const labels = projectId ? await lookupLabels(projectId) : null;
  // Routes authenticated by a project key know only the project; the lookup
  // supplies its organization too.
  if (labels) setLogContext({ org_id: labels.org_id });
  const fields = {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    duration_ms: durationMs,
    ...labelFields(labels),
  };
  const level = status >= 500 ? "error" : "info";
  logger[level](fields, "api_request");
}

function labelFields(labels: ProjectLabels | null) {
  if (!labels) return {};
  return { org_slug: labels.org_slug, project_path: labels.project_path };
}

function toSpanContext(context: RequestLogContext): SpanEnrichmentContext {
  return {
    project_id: context.project_id,
    org_id: context.org_id,
    distinctId: context.distinct_id ?? context.distinctId,
  };
}
