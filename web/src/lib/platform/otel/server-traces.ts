import type { Attributes } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import { parseKeyPairsIntoRecord } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { type Config, getConfig } from "@/config";
import { FilteredSpanProcessor } from "@/lib/platform/otel/ratel-export";

/**
 * Server traces: the requests, Postgres queries and outbound calls of this process, sent to an
 * operator's OTLP collector for APM (Cloud: the Datadog Agent sidecar on localhost). Plain OTLP,
 * no vendor library: the open-source edition sends nothing unless `otel.serverTraces.endpoint`
 * (OTEL_EXPORTER_OTLP_ENDPOINT) is set, and `otel.sdkDisabled` stops it like the rest.
 *
 * Separate from self-telemetry (`config.ts`) and from Ratel's own model-call and MCP exports: it
 * rides on the same tracer provider but has its own exporter, its own resource
 * (`otel.serverTraces.resourceAttributes`, SERVER_TRACES_RESOURCE_ATTRIBUTES, over the process's own) and never receives a model-call
 * or MCP tool span, nor a URL's query string: no request body or customer text leaves this way.
 */

export type ServerTracesConfig = {
  url: string;
  headers: Record<string, string>;
  resourceAttributes: Record<string, string>;
};

export type ServerTracesDependencies = {
  /**
   * Which spans may leave as server traces. The boot path keeps model-call and MCP tool spans
   * out: they carry customer text (and `lib/mcp` sits above this layer, so it decides there).
   */
  accept: ConstructorParameters<typeof FilteredSpanProcessor>[1];
  /** The process's own resource; `resourceAttributes` win over it. */
  baseResource: Resource;
  /** Where spans go; the OTLP/HTTP exporter for the configured URL unless a test hands one. */
  exporter?: SpanExporter;
  exportTimeoutMillis?: number;
};

/** URL attributes whose query string (and fragment) is cut before export. */
const URL_ATTRIBUTES = ["http.target", "http.url", "url.full"] as const;
/** Attributes that only ever hold a query string, dropped before export. */
const QUERY_ATTRIBUTES = ["url.query"] as const;

/** The collector to send server traces to, or null when `otel.serverTraces.endpoint` is unset. */
export function resolveServerTracesConfig(
  config: Pick<Config, "otel"> = getConfig(),
): ServerTracesConfig | null {
  if (config.otel.sdkDisabled) return null;
  const { endpoint, headers, resourceAttributes } = config.otel.serverTraces;
  const base = endpoint?.replace(/\/+$/, "");
  if (!base) return null;
  return {
    url: `${base}/v1/traces`,
    headers: keyPairs(headers),
    resourceAttributes: keyPairs(resourceAttributes),
  };
}

/** The span processor that sends server traces, for the process's tracer provider. */
export function serverTracesProcessor(
  config: ServerTracesConfig,
  { accept, baseResource, exporter, exportTimeoutMillis }: ServerTracesDependencies,
): SpanProcessor {
  const resource = baseResource.merge(resourceFromAttributes(config.resourceAttributes));
  // The exporter also adds OTEL_EXPORTER_OTLP_TRACES_HEADERS from the environment (ours win per
  // key), so with self-telemetry on, its header reaches this collector too. Point this endpoint
  // only at a collector you trust with it (Cloud: the sidecar on localhost).
  const target = exporter ?? new OTLPTraceExporter({ url: config.url, headers: config.headers });
  return new FilteredSpanProcessor(
    new BatchSpanProcessor(new ServerTracesExporter(target, resource), { exportTimeoutMillis }),
    accept,
  );
}

/** Hands each span to the inner exporter with the server-traces resource and scrubbed URLs. */
class ServerTracesExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly resource: Resource,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(
      spans.map((span) => withOverrides(span, this.resource)),
      resultCallback,
    );
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** The same span seen through a different resource and attributes; the original is untouched. */
function withOverrides(span: ReadableSpan, resource: Resource): ReadableSpan {
  return Object.create(span, {
    resource: { value: resource, enumerable: true },
    attributes: { value: scrubbed(span.attributes), enumerable: true },
  });
}

function scrubbed(attributes: Attributes): Attributes {
  const result: Attributes = { ...attributes };
  for (const key of QUERY_ATTRIBUTES) delete result[key];
  for (const key of URL_ATTRIBUTES) {
    const value = result[key];
    if (typeof value === "string") result[key] = value.replace(/[?#].*$/, "");
  }
  return result;
}

function keyPairs(value: string | undefined): Record<string, string> {
  return value ? parseKeyPairsIntoRecord(value) : {};
}
