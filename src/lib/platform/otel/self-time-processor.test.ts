import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROOT_CONTEXT,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type Span as SdkSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { annotateActiveSpan } from "./enrich";
import {
  MAX_TRACKED_REQUEST_ROOTS,
  requestRootSpanFor,
  SelfTimeSpanProcessor,
} from "./self-time-processor";

test("a local export shows named reads, self time, root enrichment, and degradation", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SelfTimeSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("self-time-test");
  const root = tracer.startSpan("request", {
    kind: SpanKind.SERVER,
    startTime: [100, 0],
  });
  const child = tracer.startSpan(
    "child",
    { startTime: [102, 0] },
    trace.setSpan(ROOT_CONTEXT, root),
  );
  const grandchild = tracer.startSpan(
    "grandchild",
    { startTime: [103, 0] },
    trace.setSpan(ROOT_CONTEXT, child),
  );

  annotateActiveSpan({ project_id: "project-1", org_id: "org-1" }, () => grandchild);

  grandchild.end([105, 0]);
  const fallback = await loadOrFallback(
    {
      operation: "trace_kpis",
      distinctId: "project:project-1",
      fallback: "fallback",
      load: () =>
        withStatementTimeout(
          async () => {
            throw new Error("canceling statement due to statement timeout");
          },
          {
            operation: "trace_kpis",
            db: {} as never,
            timeoutMs: null,
            startActiveSpan: async (name, callback) => {
              const readSpan = tracer.startSpan(
                name,
                { startTime: [106, 0] },
                trace.setSpan(ROOT_CONTEXT, root),
              );
              return callback({
                end: () => readSpan.end([107, 0]),
                recordException: (exception) => readSpan.recordException(exception),
                setStatus: (status) => readSpan.setStatus(status),
              });
            },
          },
        ),
    },
    {
      addSpanEvent: (name, attributes) => root.addEvent(name, attributes, [107, 0]),
      logError: () => undefined,
      reportServerException: () => undefined,
    },
  );
  child.end([108, 0]);
  root.end([110, 0]);
  await provider.forceFlush();

  const spans = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
  assert.equal(spans.get("grandchild")?.attributes["ratel.self_time_ms"], 2_000);
  assert.equal(spans.get("child")?.attributes["ratel.self_time_ms"], 4_000);
  assert.equal(spans.get("request")?.attributes["ratel.self_time_ms"], 4_000);
  assert.equal(fallback, "fallback");
  assert.ok(spans.has("db.read trace_kpis"));
  assert.equal(spans.get("db.read trace_kpis")?.status.code, SpanStatusCode.ERROR);
  assert.ok(spans.get("db.read trace_kpis")?.events.some((event) => event.name === "exception"));
  assert.equal(spans.get("request")?.attributes["ratel.is_request_root"], true);
  assert.equal(spans.get("request")?.attributes["ratel.project_id"], "project-1");
  assert.equal(spans.get("request")?.attributes["ratel.org_id"], "org-1");
  assert.equal(spans.get("grandchild")?.attributes["ratel.project_id"], undefined);
  assert.equal(spans.get("request")?.events[0]?.name, "read_degraded");
  assert.deepEqual(spans.get("request")?.events[0]?.attributes, {
    operation: "trace_kpis",
  });

  await provider.shutdown();
});

test("the root registry is bounded and evicts the oldest root when full", async () => {
  const traceContext = (traceId: string): SpanContext => ({
    traceId,
    spanId: traceId,
    traceFlags: 1,
  });
  const serverSpan = (traceId: string): SdkSpan =>
    ({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      spanContext: () => traceContext(traceId),
      setAttribute: () => undefined,
    }) as unknown as SdkSpan;

  const processor = new SelfTimeSpanProcessor();
  const overflow = 3;
  const total = MAX_TRACKED_REQUEST_ROOTS + overflow;
  for (let index = 0; index < total; index += 1) {
    processor.onStart(serverSpan(`trace-${index}`));
  }

  // The first `overflow` roots were evicted to keep the registry bounded…
  for (let index = 0; index < overflow; index += 1) {
    assert.equal(
      requestRootSpanFor({ spanContext: () => traceContext(`trace-${index}`) }),
      undefined,
    );
  }
  // …while the most recent `MAX_TRACKED_REQUEST_ROOTS` are still resolvable.
  assert.ok(
    requestRootSpanFor({
      spanContext: () => traceContext(`trace-${overflow}`),
    }),
  );
  assert.ok(
    requestRootSpanFor({
      spanContext: () => traceContext(`trace-${total - 1}`),
    }),
  );

  await processor.shutdown();
});
