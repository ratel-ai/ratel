import {
  type Attributes,
  isSpanContextValid,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { messageOf } from "../cli/load.js";
import { TwinParamError } from "../errors.js";
import {
  RATEL_REPLAY_ARM,
  RATEL_REPLAY_SOURCE_SESSION_ID,
  RATEL_REPLAY_SOURCE_TRACE_ID,
  RATEL_TWIN_CONFIG_HASH,
  RATEL_TWIN_ID,
  RATEL_TWIN_OVERRIDES,
  RATEL_TWIN_RUN_ID,
  stampTwinInput,
} from "../otel.js";
import { resolveParams } from "../resolve.js";
import { runTwin } from "../run.js";
import type { Twin, TwinEventPayload } from "../twin.js";
import type { RunResult, RunStartPayload } from "./runs.js";

// One playground run inside its root span (spec §10). A structured twin has no
// agent loop, so its root is `invoke_workflow <twin id>`.

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const INVOKE_WORKFLOW = "invoke_workflow";

export interface ExecuteRunOptions {
  readonly runId: string;
  readonly start: RunStartPayload;
  readonly tracer: Tracer;
  readonly signal: AbortSignal;
  readonly onEvent: (payload: TwinEventPayload) => void;
  /** Called with the trace ID as soon as the root span exists. */
  readonly onTrace?: (traceId: string) => void;
}

/** Runs the twin once under a root span with the twin attributes. Never throws. */
export async function executeRun(twin: Twin, options: ExecuteRunOptions): Promise<RunResult> {
  const { start } = options;
  let resolved: ReturnType<typeof resolveParams>;
  try {
    resolved = resolveParams(twin, start.params);
  } catch (err) {
    const code = err instanceof TwinParamError ? "invalid_params" : "run_failed";
    return { status: "error", error: { code, message: messageOf(err) } };
  }
  const attributes = rootAttributes(twin, options.runId, start, resolved);
  return options.tracer.startActiveSpan(
    `${INVOKE_WORKFLOW} ${twin.id}`,
    { attributes },
    async (span): Promise<RunResult> => {
      const spanContext = span.spanContext();
      const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
      if (traceId) options.onTrace?.(traceId);
      stampTwinInput(start.input);
      try {
        const result = await runTwin(twin, {
          input: start.input,
          overrides: start.params,
          context: start.context,
          signal: options.signal,
          onLog: (message, level) => options.onEvent({ kind: "log", level, message }),
        });
        return {
          status: "ok",
          output: result.output,
          overrides: result.overrides,
          ...(traceId ? { traceId } : {}),
        };
      } catch (err) {
        const canceled = options.signal.aborted;
        span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(err) });
        if (canceled) return { status: "canceled", ...(traceId ? { traceId } : {}) };
        return {
          status: "error",
          error: { code: "run_failed", message: `${twin.id}: run() threw: ${messageOf(err)}` },
          ...(traceId ? { traceId } : {}),
        };
      } finally {
        span.end();
      }
    },
  );
}

function rootAttributes(
  twin: Twin,
  runId: string,
  start: RunStartPayload,
  resolved: ReturnType<typeof resolveParams>,
): Attributes {
  return {
    [GEN_AI_OPERATION_NAME]: INVOKE_WORKFLOW,
    ...(start.sessionId ? { [GEN_AI_CONVERSATION_ID]: start.sessionId } : {}),
    [RATEL_TWIN_ID]: twin.id,
    [RATEL_TWIN_CONFIG_HASH]: resolved.configHash,
    [RATEL_TWIN_RUN_ID]: runId,
    // Names only, never values: a changed prompt stays on the runner.
    [RATEL_TWIN_OVERRIDES]: [...resolved.overrides],
    ...(start.replay?.sourceTraceId
      ? { [RATEL_REPLAY_SOURCE_TRACE_ID]: start.replay.sourceTraceId }
      : {}),
    ...(start.replay?.sourceSessionId
      ? { [RATEL_REPLAY_SOURCE_SESSION_ID]: start.replay.sourceSessionId }
      : {}),
    ...(start.replay?.arm ? { [RATEL_REPLAY_ARM]: start.replay.arm } : {}),
  };
}
