/**
 * Composable OTLP span-processor for multi-provider coexistence.
 *
 * OpenTelemetry's coexistence model is one provider with many span-processors, every
 * span fanning out to all of them. So a partner already running an OTel provider (e.g.
 * Langfuse + the Vercel AI SDK) adds {@link ratelSpanProcessor} to their provider's
 * `spanProcessors` to dual-export to Ratel, without Ratel owning the global provider.
 * The default {@link ratelSignalFilter} forwards only the `gen_ai.*`/`ratel.*` signal,
 * so the partner's framework `ai.*` noise stays out of Ratel.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { type InitOptions, resolveOtlpConfig } from "@ratel-ai/telemetry";

/** Predicate deciding whether a finished span is forwarded to Ratel. */
export type SpanFilter = (span: ReadableSpan) => boolean;

const NOOP_SPAN_PROCESSOR: SpanProcessor = {
  onStart: () => {},
  onEnd: () => {},
  forceFlush: async () => {},
  shutdown: async () => {},
};

/**
 * Default filter: forward only signal-bearing spans — a `ratel.*` span name, or any
 * attribute key under `gen_ai.*` / `ratel.*`. This is what lets Ratel share a provider
 * with e.g. Langfuse + the Vercel AI SDK and ingest only the gen_ai/ratel signal (the
 * AI SDK's `gen_ai.*` spans + Ratel's own `ratel.search` / `execute_tool`), dropping the
 * framework's `ai.*` wrapper noise.
 */
export function ratelSignalFilter(span: ReadableSpan): boolean {
  if (span.name.startsWith("ratel.")) return true;
  for (const key of Object.keys(span.attributes)) {
    if (key.startsWith("gen_ai.") || key.startsWith("ratel.")) return true;
  }
  return false;
}

/**
 * Build the OTLP `http/protobuf` trace exporter at the resolved Ratel endpoint. The
 * standalone exporter for callers wiring their own span-processor; {@link ratelSpanProcessor}
 * batches over it. Carries no resource — the caller's provider owns `service.name`.
 */
export function ratelTraceExporter(opts: InitOptions = {}): OTLPTraceExporter {
  const { url, headers } = resolveOtlpConfig(opts);
  return new OTLPTraceExporter({ url, headers });
}

/** Options for {@link ratelSpanProcessor}: the OTLP endpoint/auth plus an optional filter. */
export interface RatelSpanProcessorOptions extends InitOptions {
  /** Set false to skip exporter construction and return a no-op processor. */
  enabled?: boolean;
  /** Override the default {@link ratelSignalFilter}; `() => true` forwards every span. */
  spanFilter?: SpanFilter;
}

/**
 * A `BatchSpanProcessor` over the Ratel OTLP exporter that forwards only the spans
 * passing {@link RatelSpanProcessorOptions.spanFilter} (default {@link ratelSignalFilter}).
 * Add it to your own provider's `spanProcessors` to send Ratel telemetry alongside another
 * provider — no global side effects, no resource. Greenfield apps that want Ratel to own
 * the provider should call {@link init} instead. `enabled: false` returns a no-op processor
 * before resolving endpoint/auth configuration.
 */
export function ratelSpanProcessor(opts: RatelSpanProcessorOptions = {}): SpanProcessor {
  const { enabled = true, spanFilter = ratelSignalFilter, ...exporterOpts } = opts;
  if (!enabled) return NOOP_SPAN_PROCESSOR;
  const inner = new BatchSpanProcessor(ratelTraceExporter(exporterOpts));
  return {
    onStart: (span, parentContext) => inner.onStart(span, parentContext),
    onEnd: (span) => {
      if (spanFilter(span)) inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
}
