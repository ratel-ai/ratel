import { TwinInputError } from "./errors.js";
import type { ParamMap } from "./params.js";
import { resolveParams, settleParams } from "./resolve.js";
import { checkInput, type LogLevel, type Twin } from "./twin.js";

export interface RunTwinOptions<I> {
  readonly input: I;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** Receives each `ctx.log` line. */
  readonly onLog?: (message: string, level: LogLevel) => void;
  /** Receives each `ctx.textDelta` piece. */
  readonly onText?: (text: string) => void;
}

export interface RunTwinResult<O> {
  readonly output: O;
  readonly configHash: string;
  readonly overrides: readonly string[];
}

/**
 * One run: checks the input against the twin's input kind, resolves the params
 * for this run only, then calls the twin's run(). A chat run gets the
 * conversation so far in `input.messages`.
 */
export async function runTwin<P extends ParamMap, I, O, M>(
  twin: Twin<P, I, O, M>,
  options: RunTwinOptions<I>,
): Promise<RunTwinResult<O>> {
  const problem = checkInput(twin.input, options.input);
  if (problem) throw new TwinInputError(twin.id, problem);
  const resolved = resolveParams(twin, options.overrides ?? {});
  const params = await settleParams(resolved.values);
  const output = await twin.run({
    input: options.input,
    params,
    ctx: {
      twinId: twin.id,
      context: { ...twin.context, ...options.context },
      signal: options.signal ?? new AbortController().signal,
      log: (message, level = "info") => options.onLog?.(String(message), level),
      textDelta: (text) => {
        if (text !== "") options.onText?.(String(text));
      },
    },
  });
  return { output, configHash: resolved.configHash, overrides: resolved.overrides };
}
