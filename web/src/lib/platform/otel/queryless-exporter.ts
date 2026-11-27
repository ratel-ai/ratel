import type { Attributes } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/** URL attributes whose query string (and fragment) is cut before export. */
const URL_ATTRIBUTES = ["http.target", "http.url", "url.full"] as const;
/** Attributes that only ever hold a query string, dropped before export. */
const QUERY_ATTRIBUTES = ["url.query"] as const;

/**
 * Hands each span to the inner exporter without a URL's query, which can hold customer text or a
 * one-time secret (the code and the state of an OAuth callback), and with another resource if given.
 */
export class QuerylessExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly resource?: Resource,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(
      spans.map((span) => withoutQuery(span, this.resource)),
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

/** The same span seen through other attributes; the original is untouched. */
function withoutQuery(span: ReadableSpan, resource: Resource | undefined): ReadableSpan {
  return Object.create(span, {
    ...(resource ? { resource: { value: resource, enumerable: true } } : {}),
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
