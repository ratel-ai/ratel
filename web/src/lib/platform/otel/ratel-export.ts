import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Config, getConfig } from "@/config";
import { MODEL_CALL_TRACER } from "@/lib/contracts/self-telemetry";

/**
 * Ratel as a customer of itself: the model calls Ratel pays for (labelling, intent names, the
 * match-quality analyst, eval-gate replays and judges, decisions) go to a Ratel project as
 * `gen_ai.*` spans, the way a customer's agent sends them.
 *
 * Only spans from {@link MODEL_CALL_TRACER} go there. Every other span this process makes
 * (requests, Postgres, outbound HTTP, the Ratel SDK's own retrieval spans) stays with the
 * self-telemetry exporter, and the model-call spans stay out of it, so neither destination
 * receives anything new it did not decide to receive.
 *
 * Owned (ADR-0030): upstream defaults the endpoint to its own deployment. Here there is no default
 * destination: the export is off unless both `selfTelemetry.apiKey` (RATEL_SELF_TELEMETRY_API_KEY,
 * a project key; the `REPLACE_ME` seed counts as unset) and `selfTelemetry.endpoint`
 * (RATEL_SELF_TELEMETRY_ENDPOINT) are set. It rides on the self-telemetry provider. The tracer
 * name is a contract, shared with the edition.
 */

export { MODEL_CALL_TRACER };

export type RatelExportConfig = {
  url: string;
  headers: Record<string, string>;
};

/** Where model-call spans go and how they authenticate, or null unless both key and endpoint are set. */
export function resolveRatelExportConfig(
  config: Pick<Config, "selfTelemetry"> = getConfig(),
): RatelExportConfig | null {
  const { apiKey: key, endpoint: url } = config.selfTelemetry;
  if (!key || !url) return null;
  return { url, headers: { Authorization: `Bearer ${key}` } };
}

/** Whether a request origin is the export URL's, so the exporter's own requests are not traced. */
export function sameOrigin(requestOrigin: string, url: string): boolean {
  try {
    return new URL(requestOrigin).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

type ScopedSpan = Pick<ReadableSpan, "instrumentationScope">;

export function isModelCallSpan(span: ScopedSpan): boolean {
  return span.instrumentationScope?.name === MODEL_CALL_TRACER;
}

/**
 * Hands a processor only the spans `accept` keeps. Flush and shutdown always
 * pass through, so the provider's shutdown still drains the inner exporter.
 */
export class FilteredSpanProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly accept: (span: ScopedSpan) => boolean,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    if (this.accept(span)) this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.accept(span)) this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
