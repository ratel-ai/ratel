import { z } from "zod";
import type { RatelYaml } from "./config";

/**
 * The container contract of `protocol/sandbox/v1` (`run-request`, `run-response`, `error`): the
 * request of a run and the judgement of the answer. The smoke check of a version and each run
 * use it. The codes of its errors are the codes of the `ratel` CLI.
 */

export type ContractErrorCode =
  | "no_health"
  | "no_port"
  | "not_json"
  | "invalid_response"
  | "invalid_error"
  | "timeout"
  | "no_answer"
  | "run_failed"
  | (string & {});

export type ContractError = { code: ContractErrorCode; message: string };

/** `version.schema.json#/$defs/smoke`. */
export type SmokeResult =
  | { ok: true; output: unknown; durationMs: number; logs: string }
  | { ok: false; error: ContractError; durationMs: number; logs: string };

/** The answer of a container: a valid run response, or the contract error. */
export type ContainerAnswer =
  | { ok: true; response: RunResponse }
  | { ok: false; error: ContractError };

/** The logs of a container keep their end, at most this many characters. */
export const MAX_LOG_CHARS = 64 * 1024;
const REDACTED = "[redacted]";

const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const errorBodySchema = z
  .object({
    code: errorCode,
    message: z.string().min(1),
    limit: z.string().min(1).optional(),
    max: z.number().optional(),
    current: z.number().optional(),
  })
  .refine(
    (body) =>
      body.code !== "limit_reached" ||
      (body.limit !== undefined && body.max !== undefined && body.current !== undefined),
    { path: ["limit"], message: "A limit_reached error names the limit, its max and its value." },
  );

/** `error.schema.json`: the body of each non-200 answer of a container. */
export const errorSchema = z.object({ error: errorBodySchema });

export const toolModeSchema = z.enum(["simulated", "recorded", "live"]);
export type ToolMode = z.infer<typeof toolModeSchema>;

const toolCallSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    args: z.record(z.string(), z.unknown()),
    mode: toolModeSchema,
    result: z.unknown().optional(),
    error: errorBodySchema.optional(),
  })
  .refine((call) => Object.hasOwn(call, "result") || Object.hasOwn(call, "error"), {
    path: ["result"],
    message: "A tool call has a result or an error.",
  });

/** `run-response.schema.json`: the answer of a run. */
export const runResponseSchema = z
  .object({
    output: z.unknown(),
    toolCalls: z.array(toolCallSchema).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        costUsd: z.number().min(0).optional(),
      })
      .optional(),
  })
  .refine((response) => Object.hasOwn(response, "output"), {
    path: ["output"],
    message: "A run response has an output.",
  });
export type RunResponse = z.infer<typeof runResponseSchema>;

/** The `run-request` of the smoke check: the example, the default params, simulated tools. */
export function smokeRequest(config: RatelYaml, runId: string) {
  const params = Object.entries(config.params ?? {}).flatMap(([name, param]) =>
    param.default === undefined ? [] : [[name, param.default] as const],
  );
  const tools = Object.keys(config.tools ?? {}).map((name) => [name, { mode: "simulated" }]);
  return {
    v: 1 as const,
    runId,
    input: config.input.example ?? null,
    params: Object.fromEntries(params),
    tools: Object.fromEntries(tools),
    fixtures: [],
  };
}

/** Judges the answer of `POST /ratel/run` (HTTP mode). */
export function judgeHttpAnswer(status: number, body: string): ContainerAnswer {
  const parsed = parseJson(body);
  if (status !== 200) {
    const error = parsed.ok ? errorSchema.safeParse(parsed.value) : null;
    if (error?.success) {
      const { code, message } = error.data.error;
      return { ok: false, error: { code, message } };
    }
    return failed(
      "invalid_error",
      `POST /ratel/run answered ${status} with a body that is not an error: an answer other than 200 must be {"error": {"code", "message"}}.`,
    );
  }
  if (!parsed.ok)
    return failed("not_json", "POST /ratel/run answered 200 with a body that is not JSON.");
  return response(parsed.value, "POST /ratel/run answered 200");
}

/** Judges the end of the command (command mode): stdout is the answer when it exits 0. */
export function judgeCommandAnswer(exitCode: number, stdout: string): ContainerAnswer {
  if (exitCode !== 0) {
    return failed(
      "run_failed",
      `The command exited with code ${exitCode}. Its stderr is in the logs.`,
    );
  }
  const parsed = parseJson(stdout);
  const isResponse =
    parsed.ok &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    !Array.isArray(parsed.value) &&
    Object.hasOwn(parsed.value, "output");
  if (isResponse) return response(parsed.value, "The command wrote a JSON object with output");
  return { ok: true, response: { output: stdout.replace(/\r?\n$/, "") } };
}

/** The text with each secret value replaced. The longest values go first. */
export function redact(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets)].filter((value) => value.length > 0);
  values.sort((a, b) => b.length - a.length);
  return values.reduce((out, value) => out.replaceAll(value, REDACTED), text);
}

/** The end of the text, at most `max` characters. Postgres text has no NUL. */
export function tailOf(text: string, max = MAX_LOG_CHARS): string {
  const clean = text.replaceAll("\0", "");
  return clean.length <= max ? clean : clean.slice(-max);
}

function response(value: unknown, what: string): ContainerAnswer {
  const checked = runResponseSchema.safeParse(value);
  if (checked.success) return { ok: true, response: checked.data };
  const issue = checked.error.issues[0];
  const where = issue?.path.join(".");
  return failed(
    "invalid_response",
    `${what} that is not a run response: ${where ? `${where}: ` : ""}${issue?.message ?? "invalid"}.`,
  );
}

function failed(code: ContractErrorCode, message: string): ContainerAnswer {
  return { ok: false, error: { code, message } };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
