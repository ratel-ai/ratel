import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RatelYaml } from "./config";
import {
  errorSchema,
  type RunResponse,
  runResponseSchema,
  type ToolMode,
  toolModeSchema,
} from "./contract";

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "infra_error",
  "timed_out",
] as const;
/**
 * `failed` is the agent's failure. `infra_error` and `timed_out` are not a result of the agent. The
 * API shows the last three as `failed` with an error code.
 */
export type RunStatus = (typeof RUN_STATUSES)[number];

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const paramName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** A recorded tool result, as an eval case keeps it. */
export const fixtureSchema = z.object({
  tool: toolName,
  arguments: z.unknown(),
  result: z.unknown(),
});
export type ToolFixture = z.infer<typeof fixtureSchema>;

export type ToolChoice = Record<string, { mode: ToolMode }>;

/** `run-request.schema.json`: what the container of a run gets. */
export const runRequestSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  input: z.unknown().refine((input) => input !== undefined, "The request needs an input."),
  params: z.record(paramName, scalar),
  tools: z.record(toolName, z.object({ mode: toolModeSchema })),
  fixtures: z.array(
    z
      .object({ tool: toolName, args: z.record(z.string(), z.unknown()), result: z.unknown() })
      .refine((fixture) => Object.hasOwn(fixture, "result"), { path: ["result"] }),
  ),
  traceparent: z
    .string()
    .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    .optional(),
});
/**
 * The params of an eval also hold its earlier turns, so a stored request can hold a param that is
 * not a scalar.
 */
export type RunRequest = Omit<z.infer<typeof runRequestSchema>, "params"> & {
  params: Record<string, unknown>;
};

/** `start-run.request.schema.json`: the body of `POST /api/v1/sandbox-runs`. */
export const startRunRequestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .optional(),
    versionId: z.string().min(1).optional(),
    input: z.unknown(),
    params: z.record(paramName, scalar).optional(),
    tools: z.record(toolName, z.object({ mode: toolModeSchema })).optional(),
  })
  .refine((body) => body.name !== undefined || body.versionId !== undefined, {
    path: ["name"],
    message: "Give the name of a sandbox or a version id.",
  })
  .refine((body) => Object.hasOwn(body, "input"), {
    path: ["input"],
    message: "The request needs an input.",
  });

/** `sandbox-run.schema.json`: the answer of the runs API. */
export const sandboxRunSchema = z
  .object({
    runId: z.string().min(1),
    versionId: z.string().min(1),
    status: z.enum(["queued", "running", "completed", "failed"]),
    input: z.unknown().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    toolCalls: runResponseSchema.shape.toolCalls,
    usage: runResponseSchema.shape.usage,
    error: errorSchema.shape.error.optional(),
    logs: z.string().optional(),
    url: z
      .string()
      .regex(/^https?:\/\//)
      .optional(),
  })
  .refine((run) => run.status !== "failed" || run.error, {
    path: ["error"],
    message: "A failed run has an error.",
  });

/** The result of a run as an eval scores it: the response with the duration and the trace. */
export type RunResult = {
  v: 1;
  runId: string;
  status: "completed" | "failed";
  output?: unknown;
  toolCalls: Array<{
    name: string;
    arguments: unknown;
    result?: unknown;
    error?: string;
    source: "real" | "fixture" | "fake";
    durationMs?: number;
  }>;
  usage: { durationMs: number; inputTokens?: number; outputTokens?: number; costUsd?: number };
  traceId: string;
  error?: { type: string; message: string };
};

export type SandboxRun = {
  id: string;
  projectId: string;
  versionId: string;
  /** The `run-request` that the container gets. */
  request: RunRequest;
  status: RunStatus;
  /** The valid answer of the container. */
  response: RunResponse | null;
  /** The contract error code, `infra_error`, `provider_refused` or `timeout`. Null when the run completed. */
  errorCode: string | null;
  /** Why the run failed. */
  reason: string | null;
  /** The container logs, redacted, the end only. */
  logs: string | null;
  durationMs: number | null;
  /** The view of an eval. Null while the run is active and when it has no result of the agent. */
  result: RunResult | null;
  traceId: string | null;
  /** The VM of the run. */
  vmId: string | null;
  instanceRef: string | null;
  timeoutS: number;
  requestedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** The request, the input and the params, as JSON. The container reads it from a file. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

const SOURCE_OF_MODE = { live: "real", recorded: "fixture", simulated: "fake" } as const;

/**
 * The `run-request` of a run: the params with the defaults of `ratel.yaml`, and a mode for each
 * tool. A tool has the mode of the request, else its mode in `ratel.yaml`, else `simulated`.
 */
export function buildRunRequest(
  config: RatelYaml,
  run: {
    runId: string;
    input: unknown;
    params: Record<string, unknown>;
    tools: ToolChoice;
    fixtures: readonly ToolFixture[];
    traceId: string;
  },
): RunRequest {
  const defaults = Object.entries(config.params ?? {}).flatMap(([name, param]) =>
    param.default === undefined ? [] : [[name, param.default] as const],
  );
  const declared = Object.entries(config.tools ?? {}).map(
    ([name, tool]) => [name, { mode: tool.mode ?? "simulated" }] as const,
  );
  return {
    v: 1,
    runId: run.runId,
    input: run.input ?? null,
    params: { ...Object.fromEntries(defaults), ...run.params },
    tools: { ...Object.fromEntries(declared), ...run.tools },
    fixtures: run.fixtures.map(({ tool, arguments: args, result }) => ({
      tool,
      args: isObject(args) ? args : {},
      result,
    })),
    traceparent: `00-${run.traceId}-${randomBytes(8).toString("hex")}-01`,
  };
}

/**
 * Why `ratel.yaml` refuses these params and tool modes, or null. Each declared param has its type
 * and an enum one of its options. An unknown name is refused, and the message names it.
 */
export function refusedChoice(
  config: RatelYaml,
  params: Record<string, unknown>,
  tools: ToolChoice,
): string | null {
  const declared = config.params ?? {};
  for (const [name, value] of Object.entries(params)) {
    const param = declared[name];
    if (!param) return `The param ${name} is not in ratel.yaml.`;
    if (param.type === "enum") {
      const options = param.options ?? [];
      if (!options.includes(value as string | number)) {
        return `The param ${name} must be one of: ${options.join(", ")}.`;
      }
    } else if (typeof value !== param.type) {
      return `The param ${name} must be a ${param.type}.`;
    }
  }
  for (const name of Object.keys(tools)) {
    if (!config.tools?.[name]) return `The tool ${name} is not in ratel.yaml.`;
  }
  return null;
}

/** The status that the API shows. */
export function apiStatus(status: RunStatus): "queued" | "running" | "completed" | "failed" {
  return status === "infra_error" || status === "timed_out" ? "failed" : status;
}

/** The view of an eval of a stored run. */
export function resultOf(
  run: Pick<
    SandboxRun,
    "id" | "status" | "response" | "errorCode" | "reason" | "durationMs" | "traceId"
  >,
): RunResult | null {
  if (run.status !== "completed" && run.status !== "failed") return null;
  const { response } = run;
  const toolCalls = (response?.toolCalls ?? []).map((call) => ({
    name: call.name,
    arguments: call.args,
    ...(Object.hasOwn(call, "result") ? { result: call.result } : {}),
    ...(call.error ? { error: `${call.error.code}: ${call.error.message}` } : {}),
    source: SOURCE_OF_MODE[call.mode],
  }));
  const usage = { ...response?.usage, durationMs: run.durationMs ?? 0 };
  const base = { v: 1 as const, runId: run.id, toolCalls, usage, traceId: run.traceId ?? "" };
  if (run.status === "completed") {
    return { ...base, status: "completed", output: response?.output ?? null };
  }
  const error = { type: run.errorCode ?? "run_failed", message: run.reason ?? "The run failed." };
  return { ...base, status: "failed", error };
}

/** `sandbox-run.schema.json`: a run as the API shows it. `url` is its page on Ratel. */
export function sandboxRunView(run: SandboxRun, url?: string) {
  const status = apiStatus(run.status);
  const { response } = run;
  return {
    runId: run.id,
    versionId: run.versionId,
    status,
    input: run.request.input,
    params: run.request.params,
    ...(response ? { output: response.output ?? null } : {}),
    ...(response?.toolCalls ? { toolCalls: response.toolCalls } : {}),
    ...(response?.usage ? { usage: response.usage } : {}),
    ...(status === "failed"
      ? {
          error: {
            code: run.errorCode ?? "run_failed",
            message: run.reason ?? "The run failed.",
          },
        }
      : {}),
    ...(run.logs !== null ? { logs: run.logs } : {}),
    ...(url ? { url } : {}),
  };
}

/** A run as a member reads it in the console. It has no VM reference and no token. */
export function runView(run: SandboxRun) {
  return {
    runId: run.id,
    versionId: run.versionId,
    status: run.status,
    reason: run.reason,
    errorCode: run.errorCode,
    input: run.request.input,
    params: run.request.params,
    result: run.result,
    logs: run.logs,
    traceId: run.traceId,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
