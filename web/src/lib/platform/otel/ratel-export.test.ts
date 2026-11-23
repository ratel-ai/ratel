import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resolveConfig } from "@/config";
import {
  resolveRatelExportConfig as exportConfigOf,
  FilteredSpanProcessor,
  isModelCallSpan,
  MODEL_CALL_TRACER,
  sameOrigin,
} from "@/lib/platform/otel/ratel-export";

const resolveRatelExportConfig = (env: Record<string, string>) =>
  exportConfigOf(resolveConfig({ env }));
const selfTelemetryProjectId = (env: Record<string, string>) =>
  resolveConfig({ env }).selfTelemetry.projectId;

test("the export is off until a project key is set, and the Terraform seed counts as unset", () => {
  assert.equal(resolveRatelExportConfig({}), null);
  assert.equal(resolveRatelExportConfig({ RATEL_SELF_TELEMETRY_API_KEY: "" }), null);
  assert.equal(resolveRatelExportConfig({ RATEL_SELF_TELEMETRY_API_KEY: "  " }), null);
  assert.equal(resolveRatelExportConfig({ RATEL_SELF_TELEMETRY_API_KEY: "REPLACE_ME" }), null);
});

// Owned: there is no default destination; a key without an endpoint sends nothing.
test("a key alone sends nothing: the endpoint names the destination", () => {
  assert.equal(resolveRatelExportConfig({ RATEL_SELF_TELEMETRY_API_KEY: "rtl_test" }), null);
  assert.equal(
    resolveRatelExportConfig({
      RATEL_SELF_TELEMETRY_API_KEY: "rtl_test",
      RATEL_SELF_TELEMETRY_ENDPOINT: "REPLACE_ME",
    }),
    null,
  );
});

test("a key and an endpoint send to that traces route as a bearer token, like a customer's SDK", () => {
  assert.deepEqual(
    resolveRatelExportConfig({
      RATEL_SELF_TELEMETRY_API_KEY: " rtl_test ",
      RATEL_SELF_TELEMETRY_ENDPOINT: "https://app.example.com/v1/traces",
    }),
    { url: "https://app.example.com/v1/traces", headers: { Authorization: "Bearer rtl_test" } },
  );
});

test("the endpoint can point at another deployment", () => {
  assert.equal(
    resolveRatelExportConfig({
      RATEL_SELF_TELEMETRY_API_KEY: "rtl_test",
      RATEL_SELF_TELEMETRY_ENDPOINT: "http://localhost:3000/v1/traces",
    })?.url,
    "http://localhost:3000/v1/traces",
  );
});

test("the own project id is read the same way, seed and blank meaning none", () => {
  assert.equal(selfTelemetryProjectId({}), undefined);
  assert.equal(
    selfTelemetryProjectId({ RATEL_SELF_TELEMETRY_PROJECT_ID: "REPLACE_ME" }),
    undefined,
  );
  assert.equal(selfTelemetryProjectId({ RATEL_SELF_TELEMETRY_PROJECT_ID: " p-1 " }), "p-1");
});

test("the exporter's own requests are recognised by origin", () => {
  assert.equal(sameOrigin("https://cloud.ratel.sh", "https://cloud.ratel.sh/v1/traces"), true);
  assert.equal(sameOrigin("https://cloud.ratel.sh:443", "https://cloud.ratel.sh/v1/traces"), true);
  assert.equal(sameOrigin("https://api.anthropic.com", "https://cloud.ratel.sh/v1/traces"), false);
  assert.equal(sameOrigin("not a url", "https://cloud.ratel.sh/v1/traces"), false);
});

test("model-call spans go only to Ratel, and every other span only to the existing exporter", async () => {
  const ratel = new InMemorySpanExporter();
  const existing = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new FilteredSpanProcessor(
        new SimpleSpanProcessor(existing),
        (span) => !isModelCallSpan(span),
      ),
      new FilteredSpanProcessor(new SimpleSpanProcessor(ratel), isModelCallSpan),
    ],
  });

  provider.getTracer(MODEL_CALL_TRACER).startSpan("chat claude-haiku-4-5").end();
  provider.getTracer("@ratel-ai/sdk").startSpan("ratel.search").end();
  provider.getTracer("@opentelemetry/instrumentation-pg").startSpan("pg.query").end();
  await provider.forceFlush();

  assert.deepEqual(
    ratel.getFinishedSpans().map((span) => span.name),
    ["chat claude-haiku-4-5"],
  );
  assert.deepEqual(
    existing.getFinishedSpans().map((span) => span.name),
    ["ratel.search", "pg.query"],
  );
  await provider.shutdown();
});

test("flush and shutdown reach the inner processor whatever the filter says", async () => {
  const seen: string[] = [];
  const inner = {
    onStart: () => seen.push("start"),
    onEnd: () => seen.push("end"),
    forceFlush: async () => {
      seen.push("flush");
    },
    shutdown: async () => {
      seen.push("shutdown");
    },
  };
  const processor = new FilteredSpanProcessor(inner, () => false);
  await processor.forceFlush();
  await processor.shutdown();
  assert.deepEqual(seen, ["flush", "shutdown"]);
});
