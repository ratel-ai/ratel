import { toHexId } from "@/lib/ingest/otlp/decode";
import type {
  IExportTraceServiceRequest,
  RawResourceSpans,
  RawSpan,
} from "@/lib/ingest/otlp/types";
import { type RawViewPolicy, redactKeyValues, redactText } from "./redact";

/** An OTLP/JSON `ExportTraceServiceRequest`, as the "Download as OTLP JSON" button saves it. */
export interface OtlpJsonRequest {
  resourceSpans: RawResourceSpans[];
}

/**
 * One trace's OTLP/JSON file from the stored export requests (RC-412, RC-454).
 * Each request keeps every field its exporter sent, so the file does too:
 * resource and scope as sent, then only this trace's spans, each span id once
 * (the first export wins, as the raw view reads it). Attributes go through
 * `redact.ts`: credentials redacted, content left out with `read_content` off.
 */
export function traceOtlpJson(
  requests: readonly IExportTraceServiceRequest[],
  traceId: string,
  policy: RawViewPolicy,
): OtlpJsonRequest {
  const wanted = traceId.toLowerCase();
  const seen = new Set<string>();
  const resourceSpans: RawResourceSpans[] = [];
  for (const request of requests) {
    for (const resource of request.resourceSpans ?? []) {
      const scopeSpans = (resource.scopeSpans ?? []).flatMap((scoped) => {
        const spans = (scoped.spans ?? []).filter((span) => {
          const spanId = toHexId(span.spanId);
          if (toHexId(span.traceId) !== wanted || seen.has(spanId)) return false;
          seen.add(spanId);
          return true;
        });
        if (spans.length === 0) return [];
        const scope = scoped.scope;
        return [
          {
            ...scoped,
            ...(scope
              ? { scope: { ...scope, ...redactedAttributes(scope.attributes, policy) } }
              : {}),
            spans: spans.map((span) => redactSpan(span, policy)),
          },
        ];
      });
      if (scopeSpans.length === 0) continue;
      resourceSpans.push({
        ...resource,
        ...(resource.resource
          ? {
              resource: {
                ...resource.resource,
                ...redactedAttributes(resource.resource.attributes, policy),
              },
            }
          : {}),
        scopeSpans,
      });
    }
  }
  return { resourceSpans };
}

type RawKeyValues = RawSpan["attributes"];

function redactSpan(span: RawSpan, policy: RawViewPolicy): RawSpan {
  const { links, events, status, name } = span;
  return {
    ...span,
    ...(name !== undefined ? { name: redactText(name) } : {}),
    ...(status?.message !== undefined
      ? { status: { ...status, message: redactText(status.message) } }
      : {}),
    ...redactedAttributes(span.attributes, policy),
    ...(events
      ? {
          events: events.map((event) => ({
            ...event,
            ...(event.name !== undefined ? { name: redactText(event.name) } : {}),
            ...redactedAttributes(event.attributes, policy),
          })),
        }
      : {}),
    ...(links
      ? {
          links: links.map((link) => ({ ...link, ...redactedAttributes(link.attributes, policy) })),
        }
      : {}),
  };
}

function redactedAttributes(
  attributes: RawKeyValues,
  policy: RawViewPolicy,
): { attributes?: RawKeyValues } {
  return attributes ? { attributes: redactKeyValues(attributes, policy) } : {};
}
