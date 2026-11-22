import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { composition } from "@/lib/composition/ports";
import { stableErrorType } from "@/lib/contracts/error-type";
import { MODEL_CALL_TRACER, selfTelemetryProjectId } from "@/lib/contracts/self-telemetry";
import type {
  ModelCallMeta,
  ModelCallRecord,
  ModelCallUsage,
  ModelProvider,
} from "@/lib/contracts/telemetry";
import { agentRunParent } from "@/lib/platform/agent-run";
import { type AnthropicBackend, anthropicBackend } from "@/lib/platform/anthropic-backend";
import { ModelNotEnabledError } from "@/lib/platform/anthropic-errors";
import { currentLogContext } from "@/lib/platform/logger";
import { contentAttributes, type ModelCallContent } from "@/lib/platform/model-call-content";
import { reportServerException } from "@/lib/platform/telemetry";

/**
 * The model-call seam: where a module says "a model was called" (or refused, or skipped for want
 * of a key), with what it cost in tokens and time. Owned (ADR-0030): upstream's module of the same
 * names writes a spend line per call and prices it; here the open-source edition writes nothing,
 * so a tracked call only runs. An edition that tracks spend takes each record through the
 * telemetry port (`recordModelCall` in `lib/contracts/telemetry.ts`) and writes and prices the
 * line itself; `setModelCallSink` is the unpriced line, for tests and for a deployment's own use. The fields carry ids, a model name, numbers
 * and an outcome; never a prompt or an answer: only a stable `error_type` (`stableErrorType` in
 * `lib/contracts/error-type.ts`: `throttled`, `server_error`, `model_not_enabled`, ...), never a
 * class name, which the bundle mangles. A Claude model this AWS account may not call on Bedrock
 * yet also goes to the exception reporter, once per call, with the feature, model and Bedrock
 * profile.
 *
 * `backend` says which endpoint served the call: `bedrock` for a Claude call when
 * `ANTHROPIC_BACKEND=bedrock`, else `api` (the provider's own API). It is read here once, so call
 * sites never name it; an edition that prices the line adds the EU premium for a Bedrock call.
 *
 * A call Ratel pays for is also a `gen_ai.*` span for Ratel's own project (ratel-cloud #410), as
 * upstream makes it; the span is exported only where the self-telemetry export is configured
 * (`lib/platform/otel/ratel-export.ts`).
 */

export type {
  ModelCallMeta,
  ModelCallOutcome,
  ModelCallPayer,
  ModelCallRecord,
  ModelCallUsage,
  ModelProvider,
} from "@/lib/contracts/telemetry";

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

/** The endpoint that served the call: only Claude calls can go to Bedrock. */
function backendOf(provider: ModelProvider): AnthropicBackend {
  return provider === "anthropic" ? anthropicBackend() : "api";
}

/**
 * Report one model call. An edition that accounts for spend takes the raw record with the log
 * context (`TelemetryPort.recordModelCall`) and writes its own line; otherwise one `model_call`
 * line goes to the sink, when one is set. Never throws: reporting must not break the call it
 * describes.
 */
export function recordModelCall(record: ModelCallRecord): void {
  try {
    const recorder = composition.telemetry.recordModelCall;
    if (recorder) {
      recorder.call(composition.telemetry, record, currentLogContext());
      return;
    }
  } catch {
    // A reporting failure is not the call's failure.
    return;
  }
  const out = sink;
  if (!out) return;
  try {
    const context = currentLogContext();
    const cached = tokens(record.cachedTokens);
    const written = tokens(record.cacheWriteTokens);
    const type = record.outcome === "error" ? stableErrorType(record.error) : undefined;
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
        backend: backendOf(record.provider),
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
  meta: ModelCallMeta & {
    content?: ModelCallContent<NoInfer<T>>;
    /** Extra attributes for the call's span only, never the log line (the sandbox input, RC-1091). */
    spanAttributes?: Attributes;
  },
  call: () => Promise<T>,
  usageOf: (result: T) => ModelCallUsage = () => ({}),
  now: () => number = Date.now,
): Promise<T> {
  const { content, spanAttributes, ...lineMeta } = meta;
  const startedAt = now();
  const span = startModelCallSpan(lineMeta, undefined, spanAttributes);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    if (content) addContent(span, content);
    endModelCallSpan(span, {}, error);
    recordModelCall({ ...lineMeta, outcome: "error", durationMs: now() - startedAt, error });
    if (error instanceof ModelNotEnabledError) reportNotEnabled(lineMeta, error);
    throw error;
  }
  let usage: ModelCallUsage = {};
  try {
    usage = usageOf(result);
  } catch {
    // An answer without readable usage is still an answer.
  }
  if (content) addContent(span, content, result);
  endModelCallSpan(span, usage);
  recordModelCall({ ...lineMeta, ...usage, outcome: "ok", durationMs: now() - startedAt });
  return result;
}

/**
 * `recordModelCall` for a call that was made but not wrapped in
 * `trackModelCall` (the Jev judge times its own retries): the line, and the
 * span from `startedAt` to now.
 */
export function recordTracedModelCall(
  record: ModelCallRecord,
  startedAt: number,
  spanAttributes?: Attributes,
): void {
  recordModelCall(record);
  const span = startModelCallSpan(record, startedAt, spanAttributes);
  endModelCallSpan(
    span,
    record,
    record.outcome === "error" ? (record.error ?? new Error("model call failed")) : undefined,
  );
}

export type ModelCallExceptionReporter = (
  error: unknown,
  distinctId: string,
  properties: Record<string, unknown>,
) => void;

let exceptionReporter: ModelCallExceptionReporter = reportServerException;

/** Swap where a not-enabled model's exception goes (tests); returns a restore function. */
export function setModelCallExceptionReporter(next: ModelCallExceptionReporter): () => void {
  const previous = exceptionReporter;
  exceptionReporter = next;
  return () => {
    exceptionReporter = previous;
  };
}

/**
 * A Claude model this AWS account may not call on Bedrock yet, as one reported
 * exception per call: someone must accept its Marketplace agreement. Never throws.
 */
function reportNotEnabled(meta: ModelCallMeta, error: ModelNotEnabledError): void {
  try {
    const projectId = meta.projectId ?? currentLogContext().project_id ?? null;
    exceptionReporter(error, projectId ? `project:${projectId}` : "system:model-call", {
      operation: "model_call",
      feature: meta.feature,
      model: error.model,
      bedrock_profile: error.bedrockProfile,
      backend: backendOf(meta.provider),
      ...(projectId ? { project_id: projectId } : {}),
    });
  } catch {
    // A reporting failure is not the call's failure.
  }
}

/*
 * The same call as a `gen_ai.*` span, for Ratel's own project
 * (lib/platform/otel/ratel-export.ts picks these spans out by their tracer). Only calls
 * Ratel pays for: a customer's traffic is theirs, not an agent of ours. Like the log line, the
 * span carries no error message or customer id: the model, the feature as the agent's name,
 * tokens, timing and the error's stable type, and the prompt and answer the call site offers
 * (below).
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

/*
 * Content (RC-721): a call site may offer its prompt and answer with
 * `content` (`anthropicContent(request)`). They ride the span of every
 * Ratel-paid call, capped per attribute (lib/platform/model-call-content.ts).
 */

function addContent<T>(
  span: Span | undefined,
  content: ModelCallContent<T>,
  ...answer: [] | [T]
): void {
  if (!span) return;
  try {
    span.setAttributes(contentAttributes(content, ...answer));
  } catch {
    // A tracing failure is not the call's failure.
  }
}

/**
 * Owned: the core's own calls are chat completions. Upstream also names its hosted embedding
 * provider here; that call is the edition's, and its copy of this module names it.
 */
function operationOf(_provider: ModelProvider): "chat" | "embeddings" {
  return "chat";
}

/** `startTime`: when the call began, for a call traced after the fact. Inside an agent run, the run's root is its parent. */
function startModelCallSpan(
  meta: ModelCallMeta,
  startTime?: number,
  extra?: Attributes,
): Span | undefined {
  try {
    if (meta.payer !== "ratel") return undefined;
    const projectId = meta.projectId ?? currentLogContext().project_id ?? null;
    const ownProject = selfTelemetryProjectId();
    if (ownProject && projectId === ownProject) return undefined;
    const operation = operationOf(meta.provider);
    const tracer = tracerOverride ?? trace.getTracer(MODEL_CALL_TRACER);
    return tracer.startSpan(
      `${operation} ${meta.model}`,
      {
        kind: SpanKind.CLIENT,
        ...(startTime !== undefined ? { startTime } : {}),
        attributes: {
          "gen_ai.operation.name": operation,
          "gen_ai.provider.name": meta.provider,
          "gen_ai.request.model": meta.model,
          "gen_ai.agent.name": meta.feature,
          ...extra,
        },
      },
      agentRunParent(tracer),
    );
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
      attributes["error.type"] = stableErrorType(error) ?? "unknown";
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
