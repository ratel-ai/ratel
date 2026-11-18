/**
 * `examples/mcp-server-wrapper-ts` — a stdio MCP server with one tool, wrapped
 * with `instrumentMcpServer` from `@ratel-ai/sdk`. Every MCP message the client
 * sends becomes one OpenTelemetry SERVER span (`initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call get_forecast`, ...).
 *
 * The host owns the OpenTelemetry provider (Ratel registers none). This one
 * exports to:
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP JSON, `/v1/traces` appended), when set;
 * - the file named by `MCP_SPANS_FILE`, one JSON line per span, when set.
 *
 * Nothing goes to stdout: on stdio, stdout is the MCP protocol channel.
 */

import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { instrumentMcpServer } from "@ratel-ai/sdk";

const SERVICE_NAME = "weather-mcp";
const SPANS_FILE_ENV = "MCP_SPANS_FILE";

const provider = startTracing();
const server = instrumentMcpServer(new McpServer({ name: SERVICE_NAME, version: "1.0.0" }));

server.registerTool(
  "get_forecast",
  { description: "Get today's weather forecast for Rome." },
  async () => ({ content: [{ type: "text", text: "Rome: sunny, 24°C, light wind." }] }),
);

await server.connect(new StdioServerTransport());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown());
}
process.stdin.on("end", () => void shutdown());

/** Register the provider with the exporters the env vars ask for. */
function startTracing(): NodeTracerProvider {
  const spanProcessors: SpanProcessor[] = [];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS itself and appends `/v1/traces`.
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  const spansFile = process.env[SPANS_FILE_ENV];
  if (spansFile) spanProcessors.push(new SimpleSpanProcessor(jsonLinesExporter(spansFile)));
  const tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
    spanProcessors,
  });
  tracerProvider.register();
  return tracerProvider;
}

async function shutdown(): Promise<void> {
  await provider.shutdown().catch(() => {});
  process.exit(0);
}

/** Writes each span as one JSON line: the part a reader checks, not the full OTLP shape. */
function jsonLinesExporter(path: string): SpanExporter {
  return {
    export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
      for (const span of spans) {
        const line = {
          name: span.name,
          kind: span.kind,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          status: span.status,
          attributes: span.attributes,
        };
        appendFileSync(path, `${JSON.stringify(line)}\n`);
      }
      done({ code: ExportResultCode.SUCCESS });
    },
    async shutdown(): Promise<void> {},
  };
}
