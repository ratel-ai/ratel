import type { ParamMap } from "./params.js";
import { resolveParams } from "./resolve.js";
import type { Twin } from "./twin.js";

export interface RunTwinOptions<I> {
  readonly input: I;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface RunTwinResult<O> {
  readonly output: O;
  readonly configHash: string;
  readonly overrides: readonly string[];
}

/** One run: resolves the params for this run only, then calls the twin's run(). */
export async function runTwin<P extends ParamMap, I, O, M>(
  twin: Twin<P, I, O, M>,
  options: RunTwinOptions<I>,
): Promise<RunTwinResult<O>> {
  const resolved = resolveParams(twin, options.overrides ?? {});
  const output = await twin.run({
    input: options.input,
    params: resolved.values,
    ctx: {
      twinId: twin.id,
      context: { ...twin.context, ...options.context },
      signal: options.signal ?? new AbortController().signal,
    },
  });
  return { output, configHash: resolved.configHash, overrides: resolved.overrides };
}
