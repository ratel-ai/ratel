/**
 * ⚠️ Experimental: learn tool sequences from a host framework's OpenTelemetry
 * tool spans (ADR-0028).
 *
 * For a host that runs no Ratel framework adapter but already traces its
 * framework with OpenTelemetry: the processor observes `execute_tool` spans
 * that start inside a Ratel turn and reports each as an external tool call, so
 * the transition graph sees the tools Ratel did not run. It reads the turn from
 * the in-process turn scope, never from span attributes, and never changes a
 * span — exported telemetry is identical with or without it.
 *
 * Do not combine it with a Ratel adapter that already records host tools (the
 * AI SDK and Mastra adapters do), or every call is counted twice.
 */
import type { Attributes } from "@opentelemetry/api";
import { INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID } from "./capabilities.js";
import type { ToolCatalog } from "./catalog.js";
import { GET_SKILL_CONTENT_ID } from "./skill-tools.js";
import { currentTurnId } from "./turn.js";

/** The span fields the processor reads; structural, so no SDK dependency. */
export interface ExperimentalObservedSpan {
  /** Span name, e.g. `execute_tool find_task`. */
  readonly name: string;
  /** Span attributes; `gen_ai.operation.name` and `gen_ai.tool.name` are read. */
  readonly attributes: Attributes;
  /** The instrumentation that produced the span. */
  readonly instrumentationScope?: {
    /** Instrumentation name; Ratel's own is `@ratel-ai/sdk`. */
    readonly name: string;
  };
  /** OpenTelemetry JS SDK 1.x spelling of `instrumentationScope`. */
  readonly instrumentationLibrary?: {
    /** Instrumentation name. */
    readonly name: string;
  };
  /** Final status; code `2` is an error. */
  readonly status?: {
    /** `SpanStatusCode`: `2` is an error. */
    readonly code: number;
    /** The error message, when set. */
    readonly message?: string;
  };
  /** `[seconds, nanoseconds]`, set once the span has ended. */
  readonly duration?: readonly [number, number];
}

/**
 * The OpenTelemetry `SpanProcessor` contract, structurally — pass the result to
 * your tracer provider's `spanProcessors`.
 */
export interface ExperimentalToolSequenceSpanProcessor {
  /** Notes the turn a tool span starts in. */
  onStart(span: ExperimentalObservedSpan, parentContext?: unknown): void;
  /** Reports the tool call, once the span carries its outcome. */
  onEnd(span: ExperimentalObservedSpan): void;
  /** Nothing is buffered. */
  forceFlush(): Promise<void>;
  /** Nothing to release. */
  shutdown(): Promise<void>;
}

/** Ratel's own `execute_tool` spans, which the catalog already records. */
const RATEL_SCOPE = "@ratel-ai/sdk";
const GATEWAY_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);
/** OpenTelemetry `SpanStatusCode.ERROR`. */
const STATUS_ERROR = 2;

function isHostToolSpan(span: ExperimentalObservedSpan): boolean {
  const scope = span.instrumentationScope?.name ?? span.instrumentationLibrary?.name;
  if (scope === RATEL_SCOPE) return false;
  return (
    span.attributes["gen_ai.operation.name"] === "execute_tool" ||
    span.name.startsWith("execute_tool")
  );
}

function toolName(span: ExperimentalObservedSpan): string | undefined {
  const name = span.attributes["gen_ai.tool.name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * ⚠️ Experimental. A read-only span processor that feeds a host framework's
 * tool spans into `catalog`'s tool transition graph (ADR-0028).
 *
 * A span counts when it is an `execute_tool` span from any instrumentation but
 * Ratel's own, starts inside a Ratel turn (`catalog.turn(...)`), and names a
 * tool other than a gateway tool. It is recorded when it ends, with its
 * duration and error status. A framework that starts tool spans outside the
 * turn's async context contributes nothing.
 *
 * @param catalog - The catalog whose adaptive ranking learns the sequences.
 * @returns A span processor to register on your tracer provider.
 */
export function experimentalToolSequenceSpanProcessor(
  catalog: ToolCatalog,
): ExperimentalToolSequenceSpanProcessor {
  const turns = new WeakMap<object, string>();
  return {
    onStart(span) {
      if (!isHostToolSpan(span)) return;
      const turnId = currentTurnId();
      if (turnId !== undefined) turns.set(span, turnId);
    },
    onEnd(span) {
      const turnId = turns.get(span);
      if (turnId === undefined) return;
      turns.delete(span);
      const toolId = toolName(span);
      if (toolId === undefined || GATEWAY_IDS.has(toolId)) return;
      const [seconds, nanos] = span.duration ?? [0, 0];
      catalog.recordToolCall({
        toolId,
        turnId,
        tookMs: Math.max(0, seconds * 1000 + nanos / 1e6),
        ...(span.status?.code === STATUS_ERROR
          ? { error: span.status.message || "tool span ended in error" }
          : {}),
      });
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
