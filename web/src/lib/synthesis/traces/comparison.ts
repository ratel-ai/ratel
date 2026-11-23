import type { OtelSpan } from "@/lib/ingest/otlp/schema";

export interface TraceComparisonSummary {
  traceId: string;
  rootName: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  statusCode: number;
  serviceName: string | null;
  spanCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  experimentName: string | null;
  experimentArm: string | null;
}

export function summarizeTraceForComparison(spans: readonly OtelSpan[]): TraceComparisonSummary {
  if (spans.length === 0) {
    throw new TypeError("Trace comparison requires at least one span");
  }

  const ordered = [...spans].sort(compareSpanOrder);
  const root = ordered.find(({ parentSpanId }) => parentSpanId === null) ?? ordered[0];
  const experiment = ordered.find(
    ({ experimentName, experimentArm }) => experimentName !== null || experimentArm !== null,
  );
  const inputTokens = sumFinite(ordered.map(({ inputTokens: value }) => value));
  const outputTokens = sumFinite(ordered.map(({ outputTokens: value }) => value));

  return {
    traceId: root.traceId,
    rootName: root.name,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    durationMs: root.durationMs,
    statusCode: root.statusCode,
    serviceName: root.serviceName,
    spanCount: ordered.length,
    errorCount: ordered.filter(({ statusCode }) => statusCode === 2).length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: sumFinite(ordered.map(({ costUsd }) => (costUsd === null ? null : Number(costUsd)))),
    experimentName: experiment?.experimentName ?? null,
    experimentArm: experiment?.experimentArm ?? null,
  };
}

function compareSpanOrder(left: OtelSpan, right: OtelSpan): number {
  const started = left.startedAt.getTime() - right.startedAt.getTime();
  if (started !== 0) return started;
  return left.spanId < right.spanId ? -1 : left.spanId > right.spanId ? 1 : 0;
}

function sumFinite(values: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const value of values) {
    if (value != null && Number.isFinite(value)) total += value;
  }
  return total;
}
