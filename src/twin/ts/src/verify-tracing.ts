import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { SpanStore } from "./verify.js";

// The tracing of a `ratel twin verify` worker. It registers the global tracer
// provider before any project code loads, with one in-memory processor and no
// exporter. A provider the project registers later is refused by the
// OpenTelemetry API, so no span of a verify run (with its sentinels and the
// captured content) leaves the process.

/** The env var of the OTel GenAI content gate (CONVENTIONS.md, Capture). */
export const CAPTURE_CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

export interface VerifyTracing extends SpanStore {
  shutdown(): Promise<void>;
}

/**
 * Registers the in-memory provider and turns content capture on for this
 * process. Call it once, before the twins load.
 */
export function installVerifyTracing(env: NodeJS.ProcessEnv = process.env): VerifyTracing {
  env[CAPTURE_CONTENT_ENV] = "SPAN_AND_EVENT";
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return {
    spansOf: (traceId: string): ReadableSpan[] =>
      exporter.getFinishedSpans().filter((span) => span.spanContext().traceId === traceId),
    shutdown: () => provider.shutdown(),
  };
}
