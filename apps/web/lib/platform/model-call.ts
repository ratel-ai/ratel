import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { MODEL_CALL_TRACER, selfTelemetryProjectId } from "@/lib/contracts/self-telemetry";
import { currentLogContext } from "@/lib/platform/logger";

/**
 * The model-call seam: where a module says "a model was called" (or refused, or skipped for want
 * of a key), with what it cost in tokens and time. Owned (ADR-0030): upstream's module of the same
 * names writes a spend line per call and prices it; here the line goes to a sink that is unset, so
 * with nothing installed a tracked call only runs. An edition that tracks spend installs its sink
 * with `setModelCallSink` and prices the line itself. The fields carry ids, a model name, numbers
 * and an outcome; never a prompt or an answer.
 *
 * A call Ratel pays for is also a `gen_ai.*` span for Ratel's own project (ratel-cloud #410), as
 * upstream makes it; the span is exported only where the self-telemetry export is configured
 * (`lib/platform/otel/ratel-export.ts`).
 */

/** `anthropic`, `openai`, or whatever an edition's own clients name. */
export type ModelProvider = string;

export type ModelCallOutcome = "ok" | "error" | "refused_budget" | "skipped_no_key";

/** Who pays for the call: Ratel's own analysis, or a customer's traffic through Ratel. */
export type ModelCallPayer = "ratel" | "customer";

export interface ModelCallMeta {
  provider: ModelProvider;
  model: string;
  /** What the call is for, snake_case: `eval_gate_replay`, `eval_gate_judge`. */
  feature: string;
  payer: ModelCallPayer;
  organizationId?: string | null;
  projectId?: string | null;
}

export interface ModelCallUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Prompt tokens read from the provider's cache (a subset of input). */
  cachedTokens?: number | null;
  /** Prompt tokens written to the provider's cache (a subset of input). */
  cacheWriteTokens?: number | null;
}

export interface ModelCallRecord extends ModelCallMeta, ModelCallUsage {
  outcome: ModelCallOutcome;
  durationMs: number;
  /** The thrown error, for its class name only. */
  error?: unknown;
  /** How many calls the line stands for: refusals in one simulation are one line with their count. */
  calls?: number;
}

export interface ModelCallSink {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

let sink: ModelCallSink | null = null;

/** Install where the lines go (an edition, or a test); returns a restore function. */
export function setModelCallSink(next: ModelCallSink | null): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function tokens(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function errorType(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.constructor?.name || error.name || "Error";
  return typeof error;
}

/** Hand one `model_call` line to the sink. Never throws: reporting must not break the call it describes. */
export function recordModelCall(record: ModelCallRecord): void {
  const out = sink;
  if (!out) return;
  try {
    const context = currentLogContext();
    const cached = tokens(record.cachedTokens);
    const written = tokens(record.cacheWriteTokens);
    const type = record.outcome === "error" ? errorType(record.error) : undefined;
    out.info(
      {
        provider: record.provider,
        model: record.model,
        feature: record.feature,
        payer: record.payer,
        organization_id: record.organizationId ?? context.org_id ?? null,
        project_id: record.projectId ?? context.project_id ?? null,
        input_tokens: tokens(record.inputTokens),
        output_tokens: tokens(record.outputTokens),
        ...(cached !== null ? { cached_tokens: cached } : {}),
        ...(written !== null ? { cache_write_tokens: written } : {}),
        duration_ms: Math.max(0, Math.round(record.durationMs)),
        outcome: record.outcome,
        ...(record.calls !== undefined ? { calls: Math.max(1, Math.trunc(record.calls)) } : {}),
        ...(type ? { error_type: type } : {}),
      },
      "model_call",
    );
  } catch {
    // A reporting failure is not the call's failure.
  }
}

/**
 * Make `call`, report it, and hand back exactly what it returned or threw.
 * `usageOf` reads the tokens off a successful answer; a failed call reports no
 * tokens (the providers don't bill a failed request).
 */
export async function trackModelCall<T>(
  meta: ModelCallMeta,
  call: () => Promise<T>,
  usageOf: (result: T) => ModelCallUsage = () => ({}),
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  const span = startModelCallSpan(meta);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    endModelCallSpan(span, {}, error);
    recordModelCall({ ...meta, outcome: "error", durationMs: now() - startedAt, error });
    throw error;
  }
  let usage: ModelCallUsage = {};
  try {
    usage = usageOf(result);
  } catch {
    // An answer without readable usage is still an answer.
  }
  endModelCallSpan(span, usage);
  recordModelCall({ ...meta, ...usage, outcome: "ok", durationMs: now() - startedAt });
  return result;
}

/*
 * The same call as a `gen_ai.*` span, for Ratel's own project
 * (lib/platform/otel/ratel-export.ts picks these spans out by their tracer). Only calls
 * Ratel pays for: a customer's traffic is theirs, not an agent of ours. Like the log line, the
 * span carries no prompt, answer, error message or customer id: the model, the feature as the
 * agent's name, tokens, timing and the error's class name.
 *
 * The span is not made active, so the provider's HTTP span keeps its parent and the traces the
 * self-telemetry exporter receives keep their shape. With no tracer provider registered (local
 * development, tests) the API hands out no-op spans.
 */

let tracerOverride: Tracer | null = null;

/** Swap the tracer model-call spans come from (tests); returns a restore function. */
export function setModelCallTracer(next: Tracer | null): () => void {
  const previous = tracerOverride;
  tracerOverride = next;
  return () => {
    tracerOverride = previous;
  };
}

/**
 * Owned: the core's own calls are chat completions. Upstream also names its hosted embedding
 * provider here; that call is the edition's, and its copy of this module names it.
 */
function operationOf(_provider: ModelProvider): "chat" | "embeddings" {
  return "chat";
}

function startModelCallSpan(meta: ModelCallMeta): Span | undefined {
  try {
    if (meta.payer !== "ratel") return undefined;
    const projectId = meta.projectId ?? currentLogContext().project_id ?? null;
    const ownProject = selfTelemetryProjectId();
    if (ownProject && projectId === ownProject) return undefined;
    const operation = operationOf(meta.provider);
    const tracer = tracerOverride ?? trace.getTracer(MODEL_CALL_TRACER);
    return tracer.startSpan(`${operation} ${meta.model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": operation,
        "gen_ai.provider.name": meta.provider,
        "gen_ai.request.model": meta.model,
        "gen_ai.agent.name": meta.feature,
      },
    });
  } catch {
    // A tracing failure is not the call's failure.
    return undefined;
  }
}

function endModelCallSpan(span: Span | undefined, usage: ModelCallUsage, error?: unknown): void {
  if (!span) return;
  try {
    const attributes: Attributes = {};
    const input = tokens(usage.inputTokens);
    const output = tokens(usage.outputTokens);
    const cacheRead = tokens(usage.cachedTokens);
    const cacheWrite = tokens(usage.cacheWriteTokens);
    if (input !== null) attributes["gen_ai.usage.input_tokens"] = input;
    if (output !== null) attributes["gen_ai.usage.output_tokens"] = output;
    if (cacheRead !== null) attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
    if (cacheWrite !== null) attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
    if (error !== undefined) {
      attributes["error.type"] = errorType(error) ?? "Error";
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.setAttributes(attributes);
    span.end();
  } catch {
    // A tracing failure is not the call's failure.
  }
}

/** Usage off an Anthropic Messages API answer. */
export function anthropicUsage(message: {
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null;
}): ModelCallUsage {
  const usage = message.usage;
  if (!usage) return {};
  // Anthropic counts cache reads and writes apart from `input_tokens`; costFor
  // treats them as subsets of input, so the input here is all three.
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + cached + written,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokens: cached,
    cacheWriteTokens: written,
  };
}
