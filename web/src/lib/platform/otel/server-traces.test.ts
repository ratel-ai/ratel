import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { isMcpToolSpan, MCP_TOOL_TRACER } from "@/lib/mcp/telemetry/export";
import { isModelCallSpan, MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";
import {
  resolveServerTracesConfig,
  serverTracesProcessor,
} from "@/lib/platform/otel/server-traces";

const ENDPOINT = "http://localhost:4318";

function traced(environment: Record<string, string>) {
  const config = resolveServerTracesConfig(environment);
  assert.ok(config);
  const exporter = new InMemorySpanExporter();
  const processor = serverTracesProcessor(config, {
    baseResource: resourceFromAttributes({
      "service.name": "ratel-cloud",
      "deployment.environment.name": "production",
    }),
    exporter,
    accept: (span) => !isModelCallSpan(span) && !isMcpToolSpan(span),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { exporter, processor, provider };
}

test("with no OTLP endpoint there are no server traces", () => {
  assert.equal(resolveServerTracesConfig({}), null);
  assert.equal(resolveServerTracesConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }), null);
  assert.equal(
    resolveServerTracesConfig({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${ENDPOINT}/v1/traces`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ENDPOINT}/v1/logs`,
    }),
    null,
    "the self-telemetry endpoints never turn on server traces",
  );
});

test("the emergency stop wins over the endpoint", () => {
  assert.equal(
    resolveServerTracesConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_SDK_DISABLED: "true" }),
    null,
  );
});

test("the endpoint is the OTLP base: traces go to its /v1/traces, with its own headers only", () => {
  assert.deepEqual(
    resolveServerTracesConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/`,
      OTEL_EXPORTER_OTLP_HEADERS: "x-key=a",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer self-telemetry",
      SERVER_TRACES_RESOURCE_ATTRIBUTES: "service.name=ratel-app,service.version=pf-1",
    }),
    {
      url: `${ENDPOINT}/v1/traces`,
      headers: { "x-key": "a" },
      resourceAttributes: { "service.name": "ratel-app", "service.version": "pf-1" },
    },
  );
});

test("spans carry the server-traces resource over the process's own", async () => {
  const { exporter, processor, provider } = traced({
    OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
    SERVER_TRACES_RESOURCE_ATTRIBUTES:
      "service.name=ratel-app,deployment.environment.name=staging,service.version=pf-aaa-bbb",
  });
  provider.getTracer("next.js").startSpan("GET /api/health").end();
  await processor.forceFlush();

  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "GET /api/health");
  assert.deepEqual(span?.resource.attributes, {
    "service.name": "ratel-app",
    "deployment.environment.name": "staging",
    "service.version": "pf-aaa-bbb",
  });
});

test("without resource attributes the process's own resource is kept", async () => {
  const { exporter, processor, provider } = traced({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT });
  provider.getTracer("next.js").startSpan("GET /").end();
  await processor.forceFlush();
  assert.equal(exporter.getFinishedSpans()[0]?.resource.attributes["service.name"], "ratel-cloud");
});

test("model calls and MCP tool calls, which carry customer text, are never server traces", async () => {
  const { exporter, processor, provider } = traced({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT });
  provider.getTracer(MODEL_CALL_TRACER).startSpan("chat").end();
  provider.getTracer(MCP_TOOL_TRACER).startSpan("tools/call").end();
  provider.getTracer("@opentelemetry/instrumentation-pg").startSpan("pg.query:SELECT").end();
  await processor.forceFlush();
  assert.deepEqual(
    exporter.getFinishedSpans().map((span) => span.name),
    ["pg.query:SELECT"],
  );
});

test("query strings, which can carry customer text, are cut from URLs", async () => {
  const { exporter, processor, provider } = traced({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT });
  provider
    .getTracer("next.js")
    .startSpan("GET /v1/tools/pick", {
      attributes: {
        "http.target": "/v1/tools/pick?q=customer%20text",
        "http.url": "https://app.example/v1/tools/pick?q=customer",
        "url.full": "https://api.example/x?token=secret#frag",
        "url.query": "q=customer",
        "http.route": "/v1/tools/pick",
        "http.status_code": 200,
      },
    })
    .end();
  await processor.forceFlush();

  assert.deepEqual(exporter.getFinishedSpans()[0]?.attributes, {
    "http.target": "/v1/tools/pick",
    "http.url": "https://app.example/v1/tools/pick",
    "url.full": "https://api.example/x",
    "http.route": "/v1/tools/pick",
    "http.status_code": 200,
  });
});

test("the open-source build has no Datadog dependency: server traces are plain OTLP", () => {
  for (const manifest of ["package.json", "web/package.json"]) {
    const root = join(import.meta.dirname, "../../../../..");
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    });
    assert.deepEqual(
      names.filter((name) => /datadog|dd-trace/i.test(name)),
      [],
      `${manifest} must not depend on a Datadog package`,
    );
  }
});
