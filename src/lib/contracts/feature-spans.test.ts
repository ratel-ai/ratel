import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { FEATURE_TRACER, withFeatureSpan } from "@/lib/contracts/feature-spans";

function recorder() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, tracer: provider.getTracer(FEATURE_TRACER) };
}

test("a feature span is named feature.<name>.<operation> and returns the work's value", async () => {
  const { exporter, tracer } = recorder();
  const value = await withFeatureSpan(
    "hosted_apis",
    "embeddings",
    async (span) => {
      span.setAttribute("hosted_apis.inputs", 3);
      return 42;
    },
    { attributes: { "project.id": "p1" }, tracer },
  );
  assert.equal(value, 42);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "feature.hosted_apis.embeddings");
  assert.equal(span?.instrumentationScope.name, FEATURE_TRACER);
  assert.deepEqual(span?.attributes, {
    "feature.name": "hosted_apis",
    "project.id": "p1",
    "hosted_apis.inputs": 3,
  });
  assert.equal(span?.status.code, SpanStatusCode.UNSET);
});

test("a failure marks the span as an error with its stable type only, never the class, and still throws", async () => {
  const { exporter, tracer } = recorder();
  class QuotaError extends Error {}
  await assert.rejects(
    withFeatureSpan(
      "admin_mcp",
      "call",
      async () => {
        throw new QuotaError("customer text must not be traced");
      },
      { tracer },
    ),
    QuotaError,
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.status.code, SpanStatusCode.ERROR);
  assert.equal(span?.status.message, undefined);
  assert.equal(
    span?.attributes["error.type"],
    "unknown",
    "never the class name: the bundle mangles it",
  );
  assert.equal(span?.events.length, 0, "no exception event: its message could hold customer text");
});

test("a framework redirect or not-found is control flow, not an error", async () => {
  const { exporter, tracer } = recorder();
  const notFound = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
    digest: "NEXT_HTTP_ERROR_FALLBACK;404",
  });
  await assert.rejects(
    withFeatureSpan(
      "agents_pages",
      "resolve_context",
      async () => {
        throw notFound;
      },
      { tracer },
    ),
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.status.code, SpanStatusCode.UNSET);
  assert.equal(span?.attributes["feature.outcome"], "NEXT_HTTP_ERROR_FALLBACK;404");
});

test("without a registered provider the work runs untraced", async () => {
  assert.equal(await withFeatureSpan("flags", "evaluate", async () => "ok"), "ok");
});
