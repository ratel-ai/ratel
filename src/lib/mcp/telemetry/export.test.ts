import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";
import {
  isMcpToolSpan,
  MCP_TOOL_TRACER,
  mcpExportProcessors,
  resolveMcpExportConfig,
} from "./export";

/**
 * Owned (ADR-0030): upstream's file, with the no-default endpoint of ./export.ts pinned in place
 * of upstream's own deployment.
 */

const ENDPOINT = "https://ratel.example.com/v1/traces";

test("the MCP export is off until its own project key is set, and the Terraform seed counts as unset", () => {
  const endpoint = { RATEL_SELF_TELEMETRY_ENDPOINT: ENDPOINT };
  assert.equal(resolveMcpExportConfig(endpoint), null);
  assert.equal(
    resolveMcpExportConfig({ ...endpoint, RATEL_SELF_TELEMETRY_MCP_API_KEY: " " }),
    null,
  );
  assert.equal(
    resolveMcpExportConfig({ ...endpoint, RATEL_SELF_TELEMETRY_MCP_API_KEY: "REPLACE_ME" }),
    null,
  );
  assert.deepEqual(mcpExportProcessors(null), []);
});

test("the backend model-call key does not turn the MCP export on", () => {
  assert.equal(
    resolveMcpExportConfig({
      RATEL_SELF_TELEMETRY_API_KEY: "rtl_backend",
      RATEL_SELF_TELEMETRY_ENDPOINT: ENDPOINT,
    }),
    null,
  );
});

test("there is no default destination: a key without an endpoint exports nothing", () => {
  assert.equal(resolveMcpExportConfig({ RATEL_SELF_TELEMETRY_MCP_API_KEY: "rtl_mcp" }), null);
  assert.equal(
    resolveMcpExportConfig({
      RATEL_SELF_TELEMETRY_MCP_API_KEY: "rtl_mcp",
      RATEL_SELF_TELEMETRY_ENDPOINT: "REPLACE_ME",
    }),
    null,
  );
});

test("a key and an endpoint send to that traces route as a bearer token", () => {
  assert.deepEqual(
    resolveMcpExportConfig({
      RATEL_SELF_TELEMETRY_MCP_API_KEY: " rtl_mcp ",
      RATEL_SELF_TELEMETRY_ENDPOINT: ENDPOINT,
    }),
    { url: ENDPOINT, headers: { Authorization: "Bearer rtl_mcp" } },
  );
});

test("only spans from the MCP tracer are MCP tool spans", () => {
  assert.equal(isMcpToolSpan({ instrumentationScope: { name: MCP_TOOL_TRACER } }), true);
  assert.equal(isMcpToolSpan({ instrumentationScope: { name: MODEL_CALL_TRACER } }), false);
  assert.equal(isMcpToolSpan({ instrumentationScope: { name: "@ratel-ai/sdk" } }), false);
});

test("with REPLACE_ME nothing is exported, with a key only MCP tool spans are", () => {
  const exported = new InMemorySpanExporter();
  const seeded = resolveMcpExportConfig({
    RATEL_SELF_TELEMETRY_MCP_API_KEY: "REPLACE_ME",
    RATEL_SELF_TELEMETRY_ENDPOINT: ENDPOINT,
  });
  const off = new BasicTracerProvider({
    spanProcessors: mcpExportProcessors(seeded, () => new SimpleSpanProcessor(exported)),
  });
  off.getTracer(MCP_TOOL_TRACER).startSpan("execute_tool list_traces").end();
  assert.equal(exported.getFinishedSpans().length, 0);

  const on = new BasicTracerProvider({
    spanProcessors: mcpExportProcessors(
      resolveMcpExportConfig({
        RATEL_SELF_TELEMETRY_MCP_API_KEY: "rtl_mcp",
        RATEL_SELF_TELEMETRY_ENDPOINT: ENDPOINT,
      }),
      () => new SimpleSpanProcessor(exported),
    ),
  });
  on.getTracer(MCP_TOOL_TRACER).startSpan("execute_tool list_traces").end();
  on.getTracer(MODEL_CALL_TRACER).startSpan("chat claude").end();
  on.getTracer("next.js").startSpan("POST /api/mcp").end();
  assert.deepEqual(
    exported.getFinishedSpans().map((span) => span.name),
    ["execute_tool list_traces"],
  );
  // Keep the global provider untouched: these providers were never registered.
  assert.equal(trace.getTracerProvider().constructor.name, "ProxyTracerProvider");
});
