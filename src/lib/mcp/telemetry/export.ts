import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { configuredSetting } from "@/lib/contracts/self-telemetry";
import {
  FilteredSpanProcessor,
  RATEL_SELF_TELEMETRY_ENDPOINT_ENV,
  type RatelExportConfig,
} from "@/lib/platform/otel/ratel-export";

/**
 * Ratel's own MCP server as a customer of Ratel: each tool call is an `execute_tool` span
 * (lib/mcp/telemetry/trace-tool-call.ts) sent to a Ratel project of its own, the way a customer's
 * MCP server sends its own.
 *
 * Only spans from {@link MCP_TOOL_TRACER} go there, and the self-telemetry exporter leaves them
 * out: they hold a customer's tool args and results, which have no place there.
 *
 * The pattern of lib/platform/otel/ratel-export.ts with a key of its own, so the backend model
 * calls and the MCP calls land in two projects. It rides on the self-telemetry provider.
 *
 * Owned (ADR-0004): upstream defaults the endpoint to its own deployment. Here there is no default
 * destination: the export is off unless both `RATEL_SELF_TELEMETRY_MCP_API_KEY` (a project key;
 * the `REPLACE_ME` seed counts as unset) and `RATEL_SELF_TELEMETRY_ENDPOINT` are set.
 */

/** The tracer `traceMcpToolCall` makes its spans with; its scope is what this export selects on. */
export const MCP_TOOL_TRACER = "ratel-cloud/mcp";

export const RATEL_SELF_TELEMETRY_MCP_KEY_ENV = "RATEL_SELF_TELEMETRY_MCP_API_KEY";

const EXPORT_TIMEOUT_MS = 5_000;

type Environment = Readonly<Record<string, string | undefined>>;
type ScopedSpan = Pick<ReadableSpan, "instrumentationScope">;

/** Where MCP tool spans go and how they authenticate, or null unless both key and endpoint are set. */
export function resolveMcpExportConfig(environment: Environment): RatelExportConfig | null {
  const key = configuredSetting(environment[RATEL_SELF_TELEMETRY_MCP_KEY_ENV]);
  const url = configuredSetting(environment[RATEL_SELF_TELEMETRY_ENDPOINT_ENV]);
  if (!key || !url) return null;
  return { url, headers: { Authorization: `Bearer ${key}` } };
}

/** The span processors that send MCP tool spans to their project: none without a key. */
export function mcpExportProcessors(
  config: RatelExportConfig | null,
  makeInner: (config: RatelExportConfig) => SpanProcessor = batchExport,
): SpanProcessor[] {
  return config ? [new FilteredSpanProcessor(makeInner(config), isMcpToolSpan)] : [];
}

export function isMcpToolSpan(span: ScopedSpan): boolean {
  return span.instrumentationScope?.name === MCP_TOOL_TRACER;
}

function batchExport(config: RatelExportConfig): SpanProcessor {
  return new BatchSpanProcessor(new OTLPTraceExporter(config), {
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });
}
