import { type Span as ApiSpan, type HrTime, SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

type SpanInterval = {
  end: number;
  start: number;
};

type ActiveSpanTiming = {
  children: SpanInterval[];
  parentSpanId?: string;
};

/**
 * Cap the module-level root registry so a SERVER span that never ends (aborted
 * request, crashed handler, wedged exporter) can't leak its entry — and the
 * heavy SDK span it strong-references — for the whole process lifetime. Once the
 * cap is reached the oldest root is evicted (Map preserves insertion order);
 * losing a root only costs that trace its self-time root enrichment, never
 * correctness.
 */
export const MAX_TRACKED_REQUEST_ROOTS = 8_192;

const requestRootsByTraceId = new Map<string, SdkSpan>();

export class SelfTimeSpanProcessor implements SpanProcessor {
  private readonly activeSpans = new Map<string, ActiveSpanTiming>();
  private readonly requestRootTraceIds = new Set<string>();

  onStart(span: SdkSpan): void {
    const context = span.spanContext();
    this.activeSpans.set(context.spanId, {
      children: [],
      parentSpanId: span.parentSpanContext?.spanId,
    });

    if (span.kind === SpanKind.SERVER && !requestRootsByTraceId.has(context.traceId)) {
      this.evictOldestRootIfFull();
      requestRootsByTraceId.set(context.traceId, span);
      this.requestRootTraceIds.add(context.traceId);
      span.setAttribute("ratel.is_request_root", true);
    }
  }

  private evictOldestRootIfFull(): void {
    if (requestRootsByTraceId.size < MAX_TRACKED_REQUEST_ROOTS) return;
    const oldest = requestRootsByTraceId.keys().next().value;
    if (oldest === undefined) return;
    requestRootsByTraceId.delete(oldest);
    this.requestRootTraceIds.delete(oldest);
  }

  onEnding(span: SdkSpan): void {
    const context = span.spanContext();
    const timing = this.activeSpans.get(context.spanId);
    if (!timing) return;

    const interval = spanInterval(span.startTime, span.endTime);
    const childTime = coveredTime(timing.children, interval);
    const selfTimeMs = interval.end - interval.start - childTime;
    span.setAttribute("ratel.self_time_ms", Math.max(selfTimeMs, 0));

    if (timing.parentSpanId) {
      this.activeSpans.get(timing.parentSpanId)?.children.push(interval);
    }
  }

  onEnd(span: ReadableSpan): void {
    const context = span.spanContext();
    this.activeSpans.delete(context.spanId);
    if (requestRootsByTraceId.get(context.traceId)?.spanContext().spanId === context.spanId) {
      requestRootsByTraceId.delete(context.traceId);
      this.requestRootTraceIds.delete(context.traceId);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.activeSpans.clear();
    for (const traceId of this.requestRootTraceIds) {
      requestRootsByTraceId.delete(traceId);
    }
    this.requestRootTraceIds.clear();
    return Promise.resolve();
  }
}

export function requestRootSpanFor(
  activeSpan: Pick<ApiSpan, "spanContext"> | undefined,
): ApiSpan | undefined {
  if (!activeSpan) return undefined;
  return requestRootsByTraceId.get(activeSpan.spanContext().traceId);
}

function spanInterval(startTime: HrTime, endTime: HrTime): SpanInterval {
  return {
    start: hrTimeMilliseconds(startTime),
    end: hrTimeMilliseconds(endTime),
  };
}

function coveredTime(children: SpanInterval[], parent: SpanInterval): number {
  const intervals = children
    .map(({ start, end }) => ({
      start: start > parent.start ? start : parent.start,
      end: end < parent.end ? end : parent.end,
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => (left.start < right.start ? -1 : 1));
  if (intervals.length === 0) return 0;

  let covered = 0;
  let current = intervals[0];
  for (const interval of intervals.slice(1)) {
    if (interval.start <= current.end) {
      if (interval.end > current.end) current.end = interval.end;
      continue;
    }
    covered += current.end - current.start;
    current = interval;
  }
  return covered + current.end - current.start;
}

function hrTimeMilliseconds([seconds, nanoseconds]: HrTime): number {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}
