import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { appendPath, buildSpanTree, type SpanTreeNode } from "./tree";
import { type TraceSpanView, toTraceSpanView } from "./view";

const MAX_WATERFALL_PATH_SEGMENTS = 16;

export interface TraceWaterfallRow {
  span: TraceSpanView;
  depth: number;
  orphaned: boolean;
  offsetRatio: number;
  durationRatio: number;
}

export interface TraceWaterfallView {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  rows: TraceWaterfallRow[];
}

export function buildTraceWaterfall(spans: readonly OtelSpan[]): TraceWaterfallView {
  if (spans.length === 0) {
    return {
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      rows: [],
    };
  }

  const envelope = traceEnvelope(spans);
  const roots = buildSpanTree(spans, {
    maxPathSegments: MAX_WATERFALL_PATH_SEGMENTS,
  });
  const pending = [...roots].reverse();
  const rows: TraceWaterfallRow[] = [];

  while (pending.length > 0) {
    const node = pending.pop()!;
    rows.push(waterfallRow(node, envelope.startedAtMs, envelope.durationMs));
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
  }

  return {
    startedAt: new Date(envelope.startedAtMs).toISOString(),
    endedAt: new Date(envelope.endedAtMs).toISOString(),
    durationMs: envelope.durationMs,
    rows,
  };
}

/**
 * Reconstruct each row's bounded breadcrumb path from the preorder rows. Kept
 * off the wire model — paths repeat ancestor names on every row, which is pure
 * payload weight the client can rebuild in one pass from depth + name.
 */
export function deriveWaterfallPaths(rows: readonly TraceWaterfallRow[]): string[][] {
  const paths: string[][] = [];
  const ancestors: string[][] = [];

  for (const row of rows) {
    const parentPath = row.depth === 0 ? [] : (ancestors[row.depth - 1] ?? []);
    const path = appendPath(parentPath, row.span.name, MAX_WATERFALL_PATH_SEGMENTS);
    ancestors.length = row.depth;
    ancestors[row.depth] = path;
    paths.push(path);
  }

  return paths;
}

function traceEnvelope(spans: readonly OtelSpan[]): {
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
} {
  let startedAtMs = Number.POSITIVE_INFINITY;
  let endedAtMs = Number.NEGATIVE_INFINITY;

  for (const span of spans) {
    const started = span.startedAt.getTime();
    const duration = finiteDuration(span.durationMs);
    startedAtMs = Math.min(startedAtMs, started);
    endedAtMs = Math.max(endedAtMs, span.endedAt.getTime(), started + duration);
  }

  endedAtMs = Math.max(startedAtMs, endedAtMs);
  return {
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
  };
}

function waterfallRow(
  node: SpanTreeNode,
  traceStartedAtMs: number,
  traceDurationMs: number,
): TraceWaterfallRow {
  const offsetMs = node.span.startedAt.getTime() - traceStartedAtMs;
  const durationMs = finiteDuration(node.span.durationMs);
  const offsetRatio = traceDurationMs === 0 ? 0 : clamp(offsetMs / traceDurationMs, 0, 1);
  const durationRatio =
    traceDurationMs === 0 ? 0 : clamp(durationMs / traceDurationMs, 0, 1 - offsetRatio);

  return {
    span: toTraceSpanView(node.span),
    depth: node.depth,
    orphaned: node.orphaned,
    offsetRatio,
    durationRatio,
  };
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
