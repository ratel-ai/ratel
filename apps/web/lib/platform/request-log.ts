import type { Logger } from "pino";
import { getLogger, runWithLogContext, setLogContext } from "@/lib/platform/logger";
import { annotateActiveSpan, type SpanEnrichmentContext } from "@/lib/platform/otel/enrich";

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
): RouteHandler<Args> {
  return async (request, ...args) => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return runWithLogContext({ requestId }, async () => {
      const startedAt = performance.now();
      let response: Response;

      try {
        response = await handler(request, ...args);
      } catch (error) {
        logRequest(request, requestId, 500, startedAt, logger);
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
      logRequest(request, requestId, response.status, startedAt, logger);

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

function logRequest(
  request: Request,
  requestId: string,
  status: number,
  startedAt: number,
  logger: RequestLogger,
): void {
  requestLogContexts.delete(request);
  const fields = {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    duration_ms: Math.round(performance.now() - startedAt),
  };
  const level = status >= 500 ? "error" : "info";
  logger[level](fields, "api_request");
}

function toSpanContext(context: RequestLogContext): SpanEnrichmentContext {
  return {
    project_id: context.project_id,
    org_id: context.org_id,
    distinctId: context.distinct_id ?? context.distinctId,
  };
}
