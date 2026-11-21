/** A param Ratel can change per run. `T` is the type of its value inside run(). */
export type Param<T = unknown> = ModelParam | PromptParam | ScalarParam<T>;

export interface ModelParam {
  readonly kind: "model";
  /** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
  readonly default: string;
  readonly options?: readonly string[];
  readonly description?: string;
}

export interface PromptParam {
  readonly kind: "prompt";
  readonly default: string;
  readonly vars?: readonly string[];
  readonly description?: string;
}

export type ScalarParam<T = unknown> = {
  readonly kind: "scalar";
  readonly description?: string;
  /** Type-level marker of the value type. Never set at runtime. */
  readonly __value?: T;
} & (
  | {
      readonly type: "int" | "number";
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly type: "bool"; readonly default: boolean }
  | { readonly type: "enum"; readonly default: string; readonly values: readonly string[] }
  | { readonly type: "string"; readonly default: string; readonly maxLength?: number }
);

export type ParamMap = Readonly<Record<string, Param>>;

/** The values run() gets: a model param becomes `M` (the bare model ID unless the twin passes its own resolve). */
export type ParamValues<P extends ParamMap, M = string> = {
  [K in keyof P]: P[K] extends ModelParam
    ? M
    : P[K] extends PromptParam
      ? string
      : P[K] extends ScalarParam<infer T>
        ? T
        : never;
};

const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/.+$/;

export function model(
  defaultId: string,
  opts: { options?: readonly string[]; description?: string } = {},
): ModelParam {
  return { kind: "model", default: defaultId, ...opts };
}

export function prompt(
  template: string,
  opts: { vars?: readonly string[]; description?: string } = {},
): PromptParam {
  return { kind: "prompt", default: template, ...opts };
}

export function int(
  value: number,
  opts: { min?: number; max?: number; description?: string } = {},
): ScalarParam<number> {
  return { kind: "scalar", type: "int", default: value, ...opts };
}

export function number(
  value: number,
  opts: { min?: number; max?: number; description?: string } = {},
): ScalarParam<number> {
  return { kind: "scalar", type: "number", default: value, ...opts };
}

export function bool(value: boolean, opts: { description?: string } = {}): ScalarParam<boolean> {
  return { kind: "scalar", type: "bool", default: value, ...opts };
}

export function enumParam<const V extends string>(
  value: NoInfer<V>,
  values: readonly V[],
  opts: { description?: string } = {},
): ScalarParam<V> {
  return { kind: "scalar", type: "enum", default: value, values, ...opts };
}

export function string(
  value: string,
  opts: { maxLength?: number; description?: string } = {},
): ScalarParam<string> {
  return { kind: "scalar", type: "string", default: value, ...opts };
}

/** The bare model ID after the `provider/` prefix: `anthropic/claude-sonnet-5-5` → `claude-sonnet-5-5`. */
export function bareModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * Turns the text of a CLI `--set name=value` into the param's value type. Text
 * that does not parse stays text, so checkParamValue names the problem.
 */
export function coerceOverride(param: Param, raw: string): unknown {
  if (param.kind !== "scalar") return raw;
  switch (param.type) {
    case "int":
    case "number":
      return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case "bool":
      return raw === "true" ? true : raw === "false" ? false : raw;
    default:
      return raw;
  }
}

/** Why `value` does not fit `param`, or null when it fits. */
export function checkParamValue(param: Param, value: unknown): string | null {
  switch (param.kind) {
    case "model":
      if (typeof value !== "string" || !MODEL_ID.test(value))
        return "must be a provider/model string";
      if (param.options && !param.options.includes(value))
        return `must be one of ${param.options.join(", ")}`;
      return null;
    case "prompt":
      return typeof value === "string" ? null : "must be a string";
    case "scalar":
      return checkScalar(param, value);
  }
}

function checkScalar(param: ScalarParam, value: unknown): string | null {
  switch (param.type) {
    case "int":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `must be ${param.type === "int" ? "an integer" : "a number"}`;
      if (param.type === "int" && !Number.isInteger(value)) return "must be an integer";
      if (param.min !== undefined && value < param.min) return `must be at least ${param.min}`;
      if (param.max !== undefined && value > param.max) return `must be at most ${param.max}`;
      return null;
    }
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "enum":
      return typeof value === "string" && param.values.includes(value)
        ? null
        : `must be one of ${param.values.join(", ")}`;
    case "string":
      if (typeof value !== "string") return "must be a string";
      if (param.maxLength !== undefined && value.length > param.maxLength)
        return `must be at most ${param.maxLength} characters`;
      return null;
  }
}
