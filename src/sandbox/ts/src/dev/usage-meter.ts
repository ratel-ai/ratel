import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// The usage of a run as the worker measures it (RC-1234): the tokens of each
// model call of the run's trace, read from the spans as they end. run.end
// carries it, so the controller has the run's tokens and cost even when the
// trace export arrives late or never.

/** One model call of a run. */
export interface ModelCallUsage {
  readonly model: string;
  readonly provider?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The usage of one run: totals and each model call, in end order. */
export interface RunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: readonly ModelCallUsage[];
}

const INPUT = "gen_ai.usage.input_tokens";
const OUTPUT = "gen_ai.usage.output_tokens";
const MODELS = ["gen_ai.response.model", "gen_ai.request.model"] as const;
const PROVIDERS = ["gen_ai.system", "gen_ai.provider.name"] as const;
/** Traces held at once: a run takes its usage when it ends, so this only bounds what no run took. */
const MAX_TRACES = 1_000;

/**
 * A span processor that keeps the model calls of each trace. A model call is a
 * span with `gen_ai.usage.*` tokens; the AI SDK's outer spans carry `ai.usage.*`
 * totals only, so a call is counted once.
 */
export class UsageMeter implements SpanProcessor {
  readonly #calls = new Map<string, ModelCallUsage[]>();

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes;
    const input = tokens(attributes[INPUT]);
    const output = tokens(attributes[OUTPUT]);
    if (input === undefined && output === undefined) return;
    const traceId = span.spanContext().traceId;
    let calls = this.#calls.get(traceId);
    if (!calls) {
      if (this.#calls.size >= MAX_TRACES)
        this.#calls.delete(this.#calls.keys().next().value as string);
      calls = [];
      this.#calls.set(traceId, calls);
    }
    const model = firstString(attributes, MODELS) ?? span.name;
    const provider = firstString(attributes, PROVIDERS);
    calls.push({
      model,
      ...(provider ? { provider } : {}),
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
    });
  }

  /** The usage of the trace, once: it is forgotten after. Undefined when the trace made no model call. */
  take(traceId: string): RunUsage | undefined {
    const calls = this.#calls.get(traceId);
    this.#calls.delete(traceId);
    if (!calls || calls.length === 0) return undefined;
    return {
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
      calls,
    };
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.#calls.clear();
    return Promise.resolve();
  }
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function firstString(
  attributes: ReadableSpan["attributes"],
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
