import { checkParamValue, type ParamMap, type ParamValues } from "./params.js";

/** The input of a structured twin: one JSON object described by a JSON Schema. */
export interface StructuredInput<I> {
  readonly kind: "structured";
  readonly schema: Readonly<Record<string, unknown>>;
  /** Type-level marker of the input type. Never set at runtime. */
  readonly __input?: I;
}

export interface RunContext {
  readonly twinId: string;
  /** Context values by name: fixed inputs that are not under test. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Aborted when the run is canceled. */
  readonly signal: AbortSignal;
  /** Streams one log line to the playground as a `log` event. A no-op in a local run. */
  log(message: string, level?: LogLevel): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One event payload of a run, as it would leave the runner (protocol twin/v1 `run.event`). */
export type TwinEventPayload = { readonly kind: string } & Readonly<Record<string, unknown>>;

export interface TwinDefinition<P extends ParamMap, I, O, M> {
  readonly params: P;
  readonly input: StructuredInput<I>;
  readonly context?: Readonly<Record<string, unknown>>;
  /** Maps a `provider/model` value to what run() gets. Default: the bare model ID. */
  // Method syntax on purpose: a Twin<P, LabelInput> must be usable where any Twin is expected.
  resolve?(modelId: string): M;
  run(args: { input: I; params: ParamValues<P, M>; ctx: RunContext }): Promise<O> | O;
  /**
   * Runs on every event payload and on the run.end payload before they leave
   * the runner. Return a copy with sensitive values removed.
   */
  redact?(payload: TwinEventPayload): TwinEventPayload;
}

export interface Twin<P extends ParamMap = ParamMap, I = unknown, O = unknown, M = unknown>
  extends TwinDefinition<P, I, O, M> {
  readonly kind: "ratel.twin";
  readonly id: string;
}

const TWIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Declares a twin: the params Ratel can change, the input shape and the run function that calls the real code. */
export function defineTwin<P extends ParamMap, I, O, M = string>(
  id: string,
  definition: TwinDefinition<P, I, O, M>,
): Twin<P, I, O, M> {
  if (!TWIN_ID.test(id))
    throw new TypeError(
      `"${id}" is not a valid twin id: use lowercase letters, digits, '.', '_' and '-'`,
    );
  for (const [name, param] of Object.entries(definition.params)) {
    if (!PARAM_NAME.test(name)) throw new TypeError(`${id}: "${name}" is not a valid param name`);
    const problem = checkParamValue(param, param.default);
    if (problem) throw new TypeError(`${id}: ${name} default: ${problem}`);
  }
  return Object.freeze({ kind: "ratel.twin", id, ...definition });
}

export function isTwin(value: unknown): value is Twin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "ratel.twin"
  );
}

export function structured<I>(schema: Readonly<Record<string, unknown>>): StructuredInput<I> {
  return { kind: "structured", schema };
}
