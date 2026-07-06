/**
 * OpenTelemetry emission for the SDK's `ratel.*` / `gen_ai.*` funnel (ADR-0011,
 * ADR-0007). The catalog, gateway, skills, and MCP paths call these helpers to
 * open a span around each operation; the span names and attribute keys come from
 * the OTel-free `@ratel-ai/telemetry` vocabulary.
 *
 * Emission is **transparent**: spans go to whatever OpenTelemetry provider is
 * registered globally (`@opentelemetry/api`). Until a provider is wired — via a
 * host's own OTel SDK, or the convenience `configureTelemetry()` below — every
 * span is a no-op `NonRecordingSpan`, so instrumentation is effectively free and
 * the local trace stream (`recordEvent`) is untouched. This mirrors how the
 * Vercel AI SDK instruments: the library emits; the app decides where it goes.
 *
 * Message/tool content (`ratel.search.query`, tool args/result) rides span
 * attributes only when the ecosystem capture gate is on (default off), per
 * ADR-0007.
 */

import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AuthOutcome,
  ContentCapture,
  contentCaptureMode,
  EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  type InitOptions,
  RATEL_AUTH_FLOW,
  RATEL_AUTH_OUTCOME,
  RATEL_ORIGIN,
  RATEL_SEARCH,
  RATEL_SEARCH_HIT_COUNT,
  RATEL_SEARCH_QUERY,
  RATEL_SEARCH_TARGET,
  RATEL_SEARCH_TOP_K,
  RATEL_SKILL_ID,
  RATEL_SKILL_LOAD,
  RATEL_TOOL_ARGS_SIZE_BYTES,
  RATEL_UPSTREAM_REGISTER,
  RATEL_UPSTREAM_SERVER,
  RATEL_UPSTREAM_TOOL_COUNT,
  RATEL_UPSTREAM_TRANSPORT,
  type SearchTarget,
} from "@ratel-ai/telemetry";
import type { SearchOrigin } from "./catalog.js";

const TRACER_NAME = "@ratel-ai/sdk";

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Content rides span attributes only when the capture gate selects a span mode. */
function captureContentOnSpan(): boolean {
  const mode = contentCaptureMode();
  return mode === ContentCapture.SpanOnly || mode === ContentCapture.SpanAndEvent;
}

function argsSizeBytes(args: unknown): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return 0;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Close a span in the failure path: record the exception + ERROR status. */
function fail(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
}

/**
 * Wrap a tool invocation in a standard `execute_tool` span (`gen_ai.operation.name
 * = execute_tool`, enriched with `ratel.*`). Deliberately the OTel gen_ai tool
 * operation, not a bespoke span, so a generic backend understands it (ADR-0007).
 */
export function traceExecuteTool<T>(
  toolId: string,
  args: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    `${EXECUTE_TOOL} ${toolId}`,
    { kind: SpanKind.INTERNAL },
    async (span) => {
      span.setAttribute(GEN_AI_OPERATION_NAME, EXECUTE_TOOL);
      span.setAttribute(GEN_AI_TOOL_NAME, toolId);
      span.setAttribute(RATEL_TOOL_ARGS_SIZE_BYTES, argsSizeBytes(args));
      if (captureContentOnSpan()) span.setAttribute(GEN_AI_TOOL_CALL_ARGUMENTS, safeJson(args));
      try {
        const result = await run();
        if (captureContentOnSpan()) span.setAttribute(GEN_AI_TOOL_CALL_RESULT, safeJson(result));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        fail(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Wrap a capability search (tool or skill) in a `ratel.search` span. Synchronous:
 * the native BM25 search returns inline. `run` returns the hit array; its length
 * becomes `ratel.search.hit_count`.
 */
export function traceSearch<T extends { length: number }>(
  target: SearchTarget,
  query: string,
  topK: number,
  origin: SearchOrigin,
  run: () => T,
): T {
  return getTracer().startActiveSpan(RATEL_SEARCH, { kind: SpanKind.INTERNAL }, (span) => {
    span.setAttribute(RATEL_SEARCH_TARGET, target);
    span.setAttribute(RATEL_SEARCH_TOP_K, topK);
    span.setAttribute(RATEL_ORIGIN, origin);
    if (captureContentOnSpan()) span.setAttribute(RATEL_SEARCH_QUERY, query);
    try {
      const hits = run();
      span.setAttribute(RATEL_SEARCH_HIT_COUNT, hits.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return hits;
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Wrap a skill-content load in a `ratel.skill.load` span. */
export function traceSkillLoad<T>(skillId: string, run: () => T): T {
  return getTracer().startActiveSpan(RATEL_SKILL_LOAD, { kind: SpanKind.INTERNAL }, (span) => {
    span.setAttribute(RATEL_SKILL_ID, skillId);
    try {
      const body = run();
      span.setStatus({ code: SpanStatusCode.OK });
      return body;
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap an upstream-MCP registration in a `ratel.upstream.register` span. `run`
 * receives a `reportToolCount` callback to set `ratel.upstream.tool_count` once
 * the tool list is known.
 */
export function traceUpstreamRegister<T>(
  server: string,
  transport: string,
  run: (reportToolCount: (n: number) => void) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    RATEL_UPSTREAM_REGISTER,
    { kind: SpanKind.INTERNAL },
    async (span) => {
      span.setAttribute(RATEL_UPSTREAM_SERVER, server);
      span.setAttribute(RATEL_UPSTREAM_TRANSPORT, transport);
      try {
        const result = await run((n) => span.setAttribute(RATEL_UPSTREAM_TOOL_COUNT, n));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        fail(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Mark an upstream tool call that failed with a 401 / needs-reauthorization: a
 * short `ratel.auth.flow` span carrying `ratel.auth.outcome = needs_auth`.
 */
export function recordAuthNeeded(server?: string): void {
  const span = getTracer().startSpan(RATEL_AUTH_FLOW, { kind: SpanKind.INTERNAL });
  if (server) span.setAttribute(RATEL_UPSTREAM_SERVER, server);
  span.setAttribute(RATEL_AUTH_OUTCOME, AuthOutcome.NeedsAuth);
  span.end();
}

/** Handle returned by {@link configureTelemetry}; `shutdown()` flushes the exporter. */
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/**
 * Convenience wiring for the greenfield case: register a Ratel-owned OTLP exporter
 * so the spans this SDK emits are shipped to Ratel Cloud (or any OTLP endpoint).
 * Delegates to the optional `@ratel-ai/telemetry-otlp` package, lazily imported so
 * the base SDK install stays OTel-SDK-free (ADR-0007). A host that already runs its
 * own OpenTelemetry provider should skip this — the SDK's spans flow to that
 * provider automatically — and add `ratelSpanProcessor` from `@ratel-ai/telemetry-otlp`.
 */
export async function configureTelemetry(options: InitOptions = {}): Promise<TelemetryHandle> {
  let otlp: typeof import("@ratel-ai/telemetry-otlp");
  try {
    otlp = await import("@ratel-ai/telemetry-otlp");
  } catch {
    throw new Error(
      "configureTelemetry() needs the optional @ratel-ai/telemetry-otlp package. Install it " +
        "(e.g. `npm i @ratel-ai/telemetry-otlp`), or register your own OpenTelemetry provider — " +
        "the SDK emits ratel.*/gen_ai.* spans to whatever provider is active.",
    );
  }
  return otlp.init(options);
}

export type { InitOptions };
