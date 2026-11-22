import {
  type Attributes,
  isSpanContextValid,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import type { CatalogRead } from "../catalog.js";
import { messageOf } from "../cli/load.js";
import { ModelResolutionError, SandboxInputError, SandboxParamError } from "../errors.js";
import {
  RATEL_REPLAY_ARM,
  RATEL_REPLAY_SOURCE_SESSION_ID,
  RATEL_REPLAY_SOURCE_TRACE_ID,
  RATEL_SANDBOX_CONFIG_HASH,
  RATEL_SANDBOX_ID,
  RATEL_SANDBOX_OVERRIDES,
  RATEL_SANDBOX_RUN_ID,
  stampSandboxInput,
} from "../otel.js";
import { resolveParams } from "../resolve.js";
import { runSandbox } from "../run.js";
import type { Sandbox, TwinEventPayload } from "../sandbox.js";
import { resolveToolModes, type ToolChannel, ToolModeError, type ToolsParam } from "../tools.js";
import type { RunResult, RunStartPayload } from "./runs.js";

// One playground run inside its root span (spec §10). A structured sandbox has no
// agent loop, so its root is `invoke_workflow <sandbox id>`. A chat sandbox runs one
// user turn of an agent: `invoke_agent <sandbox id>`.

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const INVOKE_WORKFLOW = "invoke_workflow";
export const INVOKE_AGENT = "invoke_agent";

export interface ExecuteRunOptions {
  readonly runId: string;
  readonly start: RunStartPayload;
  readonly tracer: Tracer;
  readonly signal: AbortSignal;
  readonly onEvent: (payload: TwinEventPayload) => void;
  /** Called with the trace ID as soon as the root span exists. */
  readonly onTrace?: (traceId: string) => void;
  /** Absolute path of the sandbox file: the resolver imports the AI SDK from its project. */
  readonly sandboxFile?: string;
  /** Answers the run's fake and confirm tool calls. */
  readonly toolChannel?: ToolChannel;
  readonly confirmTimeoutMs?: number;
  /** Receives the prompts and models the run read through the SDK catalog. */
  readonly onCatalogReads?: (reads: readonly CatalogRead[]) => void;
}

/** Runs the sandbox once under a root span with the sandbox attributes. Never throws. */
export async function executeRun(sandbox: Sandbox, options: ExecuteRunOptions): Promise<RunResult> {
  const { start } = options;
  let resolved: ReturnType<typeof resolveParams>;
  try {
    resolved = resolveParams(sandbox, start.params, resolveContextOf(options));
    // Refuses a real side effect without allowReal before anything runs: the server cannot override it.
    resolveToolModes(sandbox.id, toolDescriptors(sandbox), start.toolModes);
  } catch (err) {
    const code =
      err instanceof SandboxParamError || err instanceof ToolModeError
        ? "invalid_params"
        : "run_failed";
    return { status: "error", error: { code, message: messageOf(err) } };
  }
  const operation = sandbox.input.kind === "chat" ? INVOKE_AGENT : INVOKE_WORKFLOW;
  const attributes = rootAttributes(sandbox, operation, options.runId, start, resolved);
  return options.tracer.startActiveSpan(
    `${operation} ${sandbox.id}`,
    { attributes },
    async (span): Promise<RunResult> => {
      const spanContext = span.spanContext();
      const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
      if (traceId) options.onTrace?.(traceId);
      // A chat input is the conversation: the AI SDK adapter records it under its content rules.
      if (sandbox.input.kind === "structured") stampSandboxInput(start.input);
      try {
        const result = await runSandbox(sandbox, {
          input: start.input,
          overrides: start.params,
          context: start.context,
          signal: options.signal,
          onLog: (message, level) => options.onEvent({ kind: "log", level, message }),
          onText: (text) => options.onEvent({ kind: "text.delta", text }),
          onEvent: options.onEvent,
          resolveContext: resolveContextOf(options),
          ...(start.toolModes ? { toolModes: start.toolModes } : {}),
          ...(options.toolChannel ? { toolChannel: options.toolChannel } : {}),
          ...(options.confirmTimeoutMs !== undefined
            ? { confirmTimeoutMs: options.confirmTimeoutMs }
            : {}),
        });
        options.onCatalogReads?.(result.catalogReads);
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
        if (err instanceof SandboxInputError || err instanceof ModelResolutionError) {
          return {
            status: "error",
            error: { code: "invalid_params", message: `${sandbox.id}: ${messageOf(err)}` },
            ...(traceId ? { traceId } : {}),
          };
        }
        return {
          status: "error",
          error: { code: "run_failed", message: `${sandbox.id}: run() threw: ${messageOf(err)}` },
          ...(traceId ? { traceId } : {}),
        };
      } finally {
        span.end();
      }
    },
  );
}

function resolveContextOf(options: ExecuteRunOptions) {
  return options.sandboxFile ? { from: options.sandboxFile } : {};
}

function toolDescriptors(sandbox: Sandbox) {
  return Object.values(sandbox.params).flatMap((p) =>
    p.kind === "tools" ? (p as ToolsParam).default : [],
  );
}

function rootAttributes(
  sandbox: Sandbox,
  operation: string,
  runId: string,
  start: RunStartPayload,
  resolved: ReturnType<typeof resolveParams>,
): Attributes {
  return {
    [GEN_AI_OPERATION_NAME]: operation,
    ...(start.sessionId ? { [GEN_AI_CONVERSATION_ID]: start.sessionId } : {}),
    [RATEL_SANDBOX_ID]: sandbox.id,
    [RATEL_SANDBOX_CONFIG_HASH]: resolved.configHash,
    [RATEL_SANDBOX_RUN_ID]: runId,
    // Names only, never values: a changed prompt stays on the runner.
    [RATEL_SANDBOX_OVERRIDES]: [...resolved.overrides],
    ...(start.replay?.sourceTraceId
      ? { [RATEL_REPLAY_SOURCE_TRACE_ID]: start.replay.sourceTraceId }
      : {}),
    ...(start.replay?.sourceSessionId
      ? { [RATEL_REPLAY_SOURCE_SESSION_ID]: start.replay.sourceSessionId }
      : {}),
    ...(start.replay?.arm ? { [RATEL_REPLAY_ARM]: start.replay.arm } : {}),
  };
}
