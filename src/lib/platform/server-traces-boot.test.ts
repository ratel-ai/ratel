import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { trace } from "@opentelemetry/api";
import { registerNodeInstrumentation } from "@/instrumentation.node";
import { MCP_TOOL_TRACER } from "@/lib/mcp/telemetry/export";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";

// Server traces at boot (`instrumentation.node.ts`) with only the APM collector configured, as
// Cloud's sidecar is, against a collector on this machine. The registration is once per process,
// so this case has its own file; the unset case is in self-telemetry-boot.test.ts.

const received: { path: string; body: string }[] = [];
let collector: Server;
let origin = "";
// A second server, so the outbound call is not to the collector's origin (which is never traced).
let upstream: Server;
let upstreamOrigin = "";

before(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  upstream = createServer((_req, res) => res.writeHead(204).end());
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of [collector, upstream]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("with only OTEL_EXPORTER_OTLP_ENDPOINT set, server traces and outbound calls go to it, with its resource", async () => {
  const flush = await registerNodeInstrumentation(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: origin,
      OTEL_SERVICE_NAME: "ratel-cloud",
      SERVER_TRACES_RESOURCE_ATTRIBUTES:
        "service.name=ratel-app,deployment.environment.name=staging,service.version=pf-aaa-bbb",
    },
    { deploymentEnvironment: "staging" },
  );
  assert.ok(flush, "a tracer provider is registered for server traces alone");

  await trace.getTracer("next.js").startActiveSpan("GET /api/probe", async (span) => {
    await fetch(`${upstreamOrigin}/outbound?q=customer`);
    span.end();
  });
  trace.getTracer(MODEL_CALL_TRACER).startSpan("model-call-probe").end();
  trace.getTracer(MCP_TOOL_TRACER).startSpan("mcp-tool-probe").end();
  await flush();

  const traces = received.filter((request) => request.path === "/v1/traces");
  assert.equal(traces.length > 0, true, "the spans reached the collector's /v1/traces");
  const body = traces.map((request) => request.body).join("\n");
  assert.ok(body.includes("GET /api/probe"), "the request span");
  assert.ok(body.includes("/outbound"), "the outbound call's span");
  assert.ok(!body.includes("q=customer"), "no query string");
  assert.ok(
    body.includes("ratel-app") && body.includes("pf-aaa-bbb"),
    "the server-traces resource",
  );
  assert.ok(
    !body.includes("model-call-probe") && !body.includes("mcp-tool-probe"),
    "model-call and MCP tool spans, which carry customer text, stay out",
  );
  assert.ok(!body.includes("ratel-cloud"), "not the self-telemetry service name");
  assert.ok(!body.includes("/v1/traces"), "the exporter's own requests are not traced");
  assert.equal(
    received.some((request) => request.path === "/v1/logs"),
    false,
    "no logs: self-telemetry is off",
  );
});
