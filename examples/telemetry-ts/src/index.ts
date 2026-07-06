/**
 * `examples/telemetry-ts` — emit Ratel's `ratel.*` telemetry through the standard
 * OpenTelemetry JS SDK.
 *
 * Runnable offline: it wires a `ConsoleSpanExporter` so the spans print to stdout
 * (no collector, no API key). The only Ratel-specific part is the vocabulary from
 * `@ratel-ai/telemetry` — the constants and value enums you set as span attributes.
 * In production you swap the console exporter for `init()` (shown at the end), which
 * wires the OTLP exporter to `RATEL_URL`; everything else stays identical.
 */

import type { Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import {
  contentCaptureMode,
  DEFAULT_SERVICE_NAME,
  EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_NAME,
  Origin,
  RATEL_ORIGIN,
  RATEL_SEARCH,
  RATEL_SEARCH_HIT_COUNT,
  RATEL_SEARCH_TARGET,
  RATEL_SEARCH_TOP_K,
  RATEL_TOOL_ARGS_SIZE_BYTES,
  RATEL_UPSTREAM_SERVER,
  RATEL_UPSTREAM_TRANSPORT,
  resolveOtlpConfig,
  SearchTarget,
  SEMCONV_VERSION,
} from "@ratel-ai/telemetry";
// init() lives in the exporter package so the vocabulary above stays OTel-free.
import { init } from "@ratel-ai/telemetry-otlp";

/**
 * Emit one realistic Ratel trace: a `ratel.search` (capability search) span
 * followed by an `execute_tool` span enriched with the `ratel.*` overlay. This is
 * the pattern you copy into your own agent — only the constants come from Ratel;
 * the tracer is the stock OTel SDK.
 */
function emitRatelTrace(tracer: Tracer): void {
  // 1. Capability search — the agent asks Ratel which tools fit the prompt.
  const search = tracer.startSpan(RATEL_SEARCH, {
    attributes: {
      [RATEL_ORIGIN]: Origin.Agent, // synthesized inside the agent loop
      [RATEL_SEARCH_TARGET]: SearchTarget.Tool,
      [RATEL_SEARCH_TOP_K]: 5,
      [RATEL_SEARCH_HIT_COUNT]: 2,
    },
  });
  search.end();

  // 2. Tool invocation — a standard gen_ai `execute_tool` span (so any OTel
  //    backend understands it) enriched with `ratel.*` attributes.
  const invoke = tracer.startSpan(EXECUTE_TOOL, {
    attributes: {
      [GEN_AI_OPERATION_NAME]: EXECUTE_TOOL,
      [GEN_AI_TOOL_NAME]: "send_email",
      [RATEL_ORIGIN]: Origin.Agent,
      [RATEL_TOOL_ARGS_SIZE_BYTES]: 128,
      [RATEL_UPSTREAM_SERVER]: "gmail",
      [RATEL_UPSTREAM_TRANSPORT]: "stdio",
    },
  });
  invoke.end();
}

async function main(): Promise<void> {
  console.log(`@ratel-ai/telemetry — semconv pin ${SEMCONV_VERSION}`);
  console.log(`content capture: ${contentCaptureMode()} (gated by OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT)\n`);

  // --- The runnable demo: emit spans to the console (no network) ---
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "ratel-telemetry-example" }),
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  const tracer = provider.getTracer("@ratel-ai/example-telemetry");

  console.log("--- emitting a ratel.search + execute_tool trace ---");
  emitRatelTrace(tracer);
  await provider.forceFlush();
  await provider.shutdown();

  // --- Production wiring: the same spans, exported to Ratel via init() ---
  // `resolveOtlpConfig` is pure (no network), so we can show how endpoint + auth
  // resolve without sending anything:
  const cfg = resolveOtlpConfig({ apiKey: "sk-demo", endpoint: "https://ingest.ratel.sh/v1/traces" });
  console.log("\n--- production init() would export to ---");
  console.log(`  url:         ${cfg.url}`);
  console.log(`  serviceName: ${cfg.serviceName} (default ${DEFAULT_SERVICE_NAME})`);
  console.log(`  headers:     ${Object.keys(cfg.headers).join(", ") || "(none)"}`);

  // If RATEL_URL is set, actually wire the real OTLP exporter and emit through it.
  if (process.env.RATEL_URL) {
    console.log(`\n--- RATEL_URL set — exporting a real trace to ${process.env.RATEL_URL} ---`);
    const handle = init({ apiKey: process.env.RATEL_API_KEY });
    const { trace } = await import("@opentelemetry/api");
    emitRatelTrace(trace.getTracer("@ratel-ai/example-telemetry"));
    await handle.shutdown();
  } else {
    console.log("\n(set RATEL_URL — and optionally RATEL_API_KEY — to export a real trace via init())");
  }

  console.log("\nOK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
