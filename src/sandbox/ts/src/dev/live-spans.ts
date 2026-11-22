import { type HrTime, type Span, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { TwinEventPayload } from "../sandbox.js";

// The live trace of a playground run (sandbox/v1 `span.ref`). The playground draws
// the span tree while the run streams, before the OTLP export lands. Each span of a
// watched trace sends one event when it starts and one when it ends. An event
// carries the span's place in the tree and an allowlist of attributes: the model,
// the token counts, the tool and its mode. Never a prompt, an input or an output.

export type LiveSpanEmit = (payload: TwinEventPayload) => void;

/** Attribute keys a span.ref may carry. Names, counts and modes only. */
export const LIVE_SPAN_ATTRIBUTES: readonly string[] = [
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.tool.name",
  "gen_ai.agent.name",
  "ratel.tool.mode",
  "ratel.tool.fake.source",
  "ratel.skill.id",
  "ai.operationId",
  "ai.model.id",
  "ai.usage.promptTokens",
  "ai.usage.completionTokens",
  "ai.usage.inputTokens",
  "ai.usage.outputTokens",
  "ai.toolCall.name",
];

/** The structural fields a span has in both SDK 1.x and 2.x. */
interface SpanShape {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly startTime: HrTime;
  readonly endTime?: HrTime;
  readonly status?: { readonly code: SpanStatusCode };
  readonly parentSpanId?: string;
  readonly parentSpanContext?: { readonly spanId: string };
  spanContext(): { readonly traceId: string; readonly spanId: string };
}

/** Sends the span.ref events of the traces it watches. */
export class LiveSpans {
  private readonly watched = new Map<string, LiveSpanEmit>();

  /** Add it to the tracer provider: it sees every span and sends those of watched traces. */
  readonly processor: SpanProcessor = {
    onStart: (span) => this.send(span as unknown as SpanShape, "start"),
    onEnd: (span: ReadableSpan) => this.send(span as unknown as SpanShape, "end"),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };

  /** Watches the trace of a run's root span. The root started before the watch, so its start is sent now. */
  watch(root: Span, emit: LiveSpanEmit): void {
    const shape = root as unknown as SpanShape;
    this.watched.set(shape.spanContext().traceId, emit);
    if (typeof shape.name === "string" && shape.startTime) this.send(shape, "start");
  }

  release(traceId: string): void {
    this.watched.delete(traceId);
  }

  private send(span: SpanShape, phase: "start" | "end"): void {
    const { traceId, spanId } = span.spanContext();
    const emit = this.watched.get(traceId);
    if (!emit) return;
    try {
      emit(spanRef(span, phase, traceId, spanId));
    } catch {
      // The live trace is a view: a failed send must never break the run.
    }
  }
}

function spanRef(
  span: SpanShape,
  phase: "start" | "end",
  traceId: string,
  spanId: string,
): TwinEventPayload {
  const parentSpanId = span.parentSpanContext?.spanId ?? span.parentSpanId;
  const ended = phase === "end" && span.endTime;
  return {
    kind: "span.ref",
    phase,
    traceId,
    spanId,
    name: span.name,
    ...(parentSpanId ? { parentSpanId } : {}),
    startMs: toMs(span.startTime),
    ...(ended && span.endTime ? { endMs: toMs(span.endTime) } : {}),
    ...(phase === "end"
      ? { status: span.status?.code === SpanStatusCode.ERROR ? "error" : "ok" }
      : {}),
    attributes: pickAttributes(span.attributes),
  };
}

function pickAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of LIVE_SPAN_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      out[key] = value;
  }
  return out;
}

function toMs(time: HrTime): number {
  return time[0] * 1000 + Math.floor(time[1] / 1e6);
}
