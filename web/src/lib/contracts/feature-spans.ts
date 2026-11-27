import { type Attributes, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

/**
 * Feature spans: one span named `feature.<name>.<operation>` where a feature is wired in, so each
 * ported feature shows in APM (server traces, `lib/platform/otel/server-traces.ts`) with its own
 * latency and error rate. A contract, so the core and the edition name them the same way.
 *
 * Attributes are ids, names and numbers only, never user content (asks, prompts, labels). A
 * failure records the error's type, never its message, which can hold a provider's or a
 * customer's text. Without a registered tracer provider (no telemetry configured) the work runs
 * untraced and nothing leaves the process.
 */

/** The ported Cloud features that carry feature spans. */
export type FeatureName =
  | "flags"
  | "admin_mcp"
  | "agents_pages"
  | "tool_run_insights"
  | "hosted_apis"
  | "scorers"
  | "alerts"
  | "explore"
  | "rql";

export type FeatureSpanOptions = {
  attributes?: Attributes;
  /** The tracer to start the span on; the {@link FEATURE_TRACER} one by default. */
  tracer?: Tracer;
};

/** The instrumentation scope of feature spans. */
export const FEATURE_TRACER = "ratel/features";

/** Runs `work` inside the span `feature.<feature>.<operation>` and returns what it returns. */
export async function withFeatureSpan<T>(
  feature: FeatureName,
  operation: string,
  work: (span: Span) => Promise<T>,
  { attributes, tracer = trace.getTracer(FEATURE_TRACER) }: FeatureSpanOptions = {},
): Promise<T> {
  return tracer.startActiveSpan(
    featureSpanName(feature, operation),
    { attributes: { "feature.name": feature, ...attributes } },
    async (span) => {
      try {
        return await work(span);
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** `feature.<feature>.<operation>`: low-cardinality, so monitors can group by it. */
export function featureSpanName(feature: FeatureName, operation: string): string {
  return `feature.${feature}.${operation}`;
}

/**
 * Next's `redirect()` and `notFound()` throw errors with a `NEXT_` digest: control flow, recorded
 * as the outcome. Anything else is an error, recorded by its type.
 */
function recordFailure(span: Span, error: unknown): void {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) {
    span.setAttribute("feature.outcome", digest);
    return;
  }
  span.setAttribute("error.type", errorType(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || "Error";
  return typeof error;
}
