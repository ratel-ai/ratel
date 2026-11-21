import { type ParamIssue, TwinParamError } from "./errors.js";
import { canonicalJson, configHash } from "./hash.js";
import { bareModelId, checkParamValue, type ParamMap, type ParamValues } from "./params.js";
import { editedToolset, type ToolEdit, toolsHashValue } from "./tools.js";
import type { Twin } from "./twin.js";

export interface ResolvedParams<P extends ParamMap, M> {
  /**
   * What run() gets: models mapped by the twin's resolve, or to their bare ID.
   * An async resolve leaves a promise here: settleParams waits for it.
   */
  readonly values: ParamValues<P, M | PromiseLike<M>>;
  /**
   * The param values as data (models as `provider/model`, tools as their enabled
   * names and descriptions). The config hash covers these. Tool modes are not here.
   */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly configHash: string;
  /** Names of params whose value differs from the default, in declaration order. */
  readonly overrides: readonly string[];
}

/**
 * Applies per-run overrides to a twin's defaults. Every override is checked
 * against its param (kind, min/max, enum, length). An unknown name is
 * rejected: Ratel can never add a param. Throws TwinParamError (invalid_params).
 */
export function resolveParams<P extends ParamMap, M>(
  twin: Twin<P, unknown, unknown, M>,
  overrides: Readonly<Record<string, unknown>>,
): ResolvedParams<P, M> {
  const issues: ParamIssue[] = [];
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(twin.params, name))
      issues.push({ param: name, message: "is an unknown param" });
  }
  const raw: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const [name, param] of Object.entries(twin.params)) {
    if (!Object.hasOwn(overrides, name)) {
      raw[name] = param.kind === "tools" ? toolsHashValue(param) : param.default;
      continue;
    }
    const value = overrides[name];
    const problem = checkParamValue(param, value);
    if (problem) issues.push({ param: name, message: problem });
    if (param.kind === "tools") {
      // The hash form: enabled tools and their descriptions. Modes are never in it.
      raw[name] = problem ? value : toolsHashValue(param, value as ToolEdit[]);
      if (!problem && canonicalJson(raw[name]) !== canonicalJson(toolsHashValue(param)))
        changed.push(name);
      continue;
    }
    raw[name] = value;
    if (value !== param.default) changed.push(name);
  }
  if (issues.length > 0) throw new TwinParamError(twin.id, sortByDeclaration(issues, twin.params));

  const resolve = twin.resolve;
  const resolveModel = resolve ? (id: string) => handled(resolve(id)) : bareModelId;
  const values: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(twin.params)) {
    values[name] =
      param.kind === "model"
        ? resolveModel(raw[name] as string)
        : param.kind === "tools"
          ? editedToolset(param, overrides[name] as ToolEdit[] | undefined)
          : raw[name];
  }
  return {
    values: values as ParamValues<P, M | PromiseLike<M>>,
    raw,
    configHash: configHash(raw),
    overrides: changed,
  };
}

/** Waits for every model value an async resolve returned. */
export async function settleParams<P extends ParamMap, M>(
  values: ParamValues<P, M | PromiseLike<M>>,
): Promise<ParamValues<P, M>> {
  const entries = await Promise.all(
    Object.entries(values).map(async ([name, value]) => [name, await value] as const),
  );
  return Object.fromEntries(entries) as ParamValues<P, M>;
}

/**
 * An async model value is awaited only when the run starts. Marks its promise
 * as handled, so a run refused before that (or a caller that reads only the
 * hash) leaves no unhandled rejection. Awaiting it still rejects.
 */
function handled<M>(value: M | PromiseLike<M>): M | PromiseLike<M> {
  if (typeof (value as PromiseLike<M> | null)?.then !== "function") return value;
  const promise = Promise.resolve(value);
  promise.catch(() => {});
  return promise;
}

function sortByDeclaration(issues: ParamIssue[], params: ParamMap): ParamIssue[] {
  const order = Object.keys(params);
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  return issues.sort((a, b) => rank(a.param) - rank(b.param));
}
