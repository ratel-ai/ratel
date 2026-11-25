import { gzipSync } from "node:zlib";
import { z } from "zod";

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "infra_error",
  "timed_out",
] as const;
/** `failed` is the agent's failure. `infra_error` and `timed_out` are not a result of the agent. */
export type RunStatus = (typeof RUN_STATUSES)[number];

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const amount = z.number().min(0);

export const fixtureSchema = z.object({
  tool: toolName,
  arguments: z.unknown(),
  result: z.unknown(),
});
export type ToolFixture = z.infer<typeof fixtureSchema>;

/** `run-input.schema.json` of `protocol/sandbox/v1`. */
export type RunInput = {
  v: 1;
  runId: string;
  input: unknown;
  params: Record<string, unknown>;
  toolPolicy: { sideEffects: "fake" };
  fixtures: ToolFixture[];
};

/** `run-result.schema.json` of `protocol/sandbox/v1`. */
export const runResultSchema = z
  .object({
    v: z.literal(1),
    runId: z.uuid(),
    status: z.enum(["completed", "failed"]),
    output: z.unknown().optional(),
    toolCalls: z.array(
      z.object({
        name: toolName,
        arguments: z.unknown(),
        result: z.unknown().optional(),
        error: z.string().optional(),
        source: z.enum(["real", "fixture", "fake"]),
        durationMs: amount.optional(),
      }),
    ),
    usage: z.object({
      durationMs: amount,
      inputTokens: amount.optional(),
      outputTokens: amount.optional(),
      costUsd: amount.optional(),
    }),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  })
  .refine((result) => result.status === "completed" || result.error, "a failed run has an error");
export type RunResult = z.infer<typeof runResultSchema>;

export type SandboxRun = {
  id: string;
  projectId: string;
  versionId: string;
  runInput: RunInput;
  status: RunStatus;
  result: RunResult | null;
  reason: string | null;
  traceId: string | null;
  instanceRef: string | null;
  timeoutS: number;
  requestedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  instanceStoppedAt: Date | null;
};

/** One variable of a process has at most 128 KB on Linux. */
export const MAX_ENCODED_INPUT_BYTES = 96 * 1024;

/** The run input as the runner reads it from its environment. */
export function encodeRunInput(input: RunInput): string {
  return gzipSync(JSON.stringify(input)).toString("base64");
}

/** The value without NUL characters, which Postgres does not store. */
export function storable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "string") return item.replaceAll("\0", "");
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key.replaceAll("\0", ""), entry]),
      );
    }),
  );
}

/** A run as a member reads it. It has no instance reference and no token. */
export function runView(run: SandboxRun) {
  return {
    runId: run.id,
    versionId: run.versionId,
    status: run.status,
    reason: run.reason,
    input: run.runInput.input,
    params: run.runInput.params,
    result: run.result,
    traceId: run.traceId,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
