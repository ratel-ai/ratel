import { type ParamIssue, TwinParamError } from "./errors.js";
import { configHash } from "./hash.js";
import { bareModelId, checkParamValue, type ParamMap, type ParamValues } from "./params.js";
import type { Twin } from "./twin.js";

export interface ResolvedParams<P extends ParamMap, M> {
  /** What run() gets: models mapped by the twin's resolve, or to their bare ID. */
  readonly values: ParamValues<P, M>;
  /** The param values as data (models as `provider/model`). The config hash covers these. */
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
      raw[name] = param.default;
      continue;
    }
    const value = overrides[name];
    const problem = checkParamValue(param, value);
    if (problem) issues.push({ param: name, message: problem });
    raw[name] = value;
    if (value !== param.default) changed.push(name);
  }
  if (issues.length > 0) throw new TwinParamError(twin.id, sortByDeclaration(issues, twin.params));

  const resolveModel = twin.resolve ? (id: string) => twin.resolve?.(id) : bareModelId;
  const values: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(twin.params)) {
    values[name] = param.kind === "model" ? resolveModel(raw[name] as string) : raw[name];
  }
  return {
    values: values as ParamValues<P, M>,
    raw,
    configHash: configHash(raw),
    overrides: changed,
  };
}

function sortByDeclaration(issues: ParamIssue[], params: ParamMap): ParamIssue[] {
  const order = Object.keys(params);
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  return issues.sort((a, b) => rank(a.param) - rank(b.param));
}
