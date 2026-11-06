import type { Attributes, Context, Link, SpanKind } from "@opentelemetry/api";
import {
  ParentBasedSampler,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

const PATH_ATTRIBUTE_KEYS = [
  "http.route",
  "url.path",
  "http.target",
  "next.route",
  "http.url",
] as const;

export class DropNoiseSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (isNoisePath(pathFromSpan(spanName, attributes))) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `DropNoiseSampler{${this.delegate.toString()}}`;
  }
}

export function createSelfTelemetrySampler(ratio: number = 1): Sampler {
  const ratioSampler = new TraceIdRatioBasedSampler(ratio);
  return new DropNoiseSampler(
    new ParentBasedSampler({
      root: ratioSampler,
      remoteParentSampled: ratioSampler,
    }),
  );
}

function pathFromSpan(spanName: string, attributes: Attributes): string | null {
  for (const key of PATH_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    if (typeof value === "string") return normalizePath(value);
  }

  const path = spanName.match(/(?:^|\s)(\/[^\s]*)/)?.[1];
  return path ? normalizePath(path) : null;
}

function normalizePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function isNoisePath(path: string | null): boolean {
  if (!path) return false;
  return (
    path === "/api/health" ||
    path === "/ingest" ||
    path.startsWith("/ingest/") ||
    path === "/_next" ||
    path.startsWith("/_next/") ||
    path.startsWith("/favicon")
  );
}
