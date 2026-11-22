import type { CatalogRead, RegisteredSkill, RegisteredTool, SetupCapture } from "./catalog.js";
import { checkParamValue, model, type Param, type ParamMap, prompt } from "./params.js";
import { PARAM_NAME, type Sandbox, type SdkParamSource } from "./sandbox.js";
import { type ToolHints, tools } from "./tools.js";

/** The name of the param that holds the tools registered on the SDK. */
export const SDK_TOOLS_PARAM = "tools";
/** The name of the param that holds the skills registered on the SDK (the tools shape). */
export const SDK_SKILLS_PARAM = "skills";

/**
 * Adds the params that come from the SDK to a sandbox: each prompt and model the code
 * read through the catalog (named by its catalog id) and the tools registered on a
 * `ratel()` core (one `tools` param). The default of a prompt or model param is its
 * baseline: the local catalog file's value when it has one, else the code's default.
 *
 * A declared param wins a name clash and keeps `source: "declared"`, but stays bound to
 * the SDK read: a declared prompt or model with the same kind and id, and a declared
 * tools param that lists SDK tools, are what the code reads through the SDK. SDK tools
 * that no declared tools param lists go to the `tools` param when that name is free.
 * Returns the same sandbox when the capture adds nothing, so a runner can tell when its
 * manifest changed.
 *
 * A catalog id that is not a valid param name, or a baseline that is not a valid value
 * (a model id without `provider/`), is skipped. The skills registered on the SDK go to
 * the `skills` param (the tools shape), bound to `ratel.skills()` the same way.
 */
export function withSdkParams<S extends Sandbox>(sandbox: S, capture: SetupCapture): S {
  const added: Record<string, Param> = {};
  const sources: Record<string, SdkParamSource> = {};
  const bindings: Record<string, SdkParamSource> = { ...bindingsOf(sandbox) };
  const known = Object.keys(bindings).length;
  const paramOf = (name: string): Param | undefined =>
    Object.hasOwn(sandbox.params, name) ? sandbox.params[name] : added[name];
  for (const read of capture.reads) {
    if (!PARAM_NAME.test(read.id)) continue;
    const existing = paramOf(read.id);
    if (existing) {
      if (existing.kind === read.kind && !bindings[read.id])
        bindings[read.id] = { kind: read.kind, id: read.id };
      continue;
    }
    const param = catalogParam(read);
    if (!param) continue;
    added[read.id] = param;
    sources[read.id] = bindings[read.id] = { kind: read.kind, id: read.id };
  }
  const covered = new Set<string>();
  for (const [name, param] of Object.entries(sandbox.params)) {
    if (param.kind !== "tools") continue;
    const listed = param.default.filter((t) => capture.tools.some((r) => r.id === t.name));
    if (listed.length === 0) continue;
    for (const t of listed) covered.add(t.name);
    if (!bindings[name]) bindings[name] = { kind: "tools" };
  }
  const uncovered = capture.tools.filter((t) => !covered.has(t.id));
  if (uncovered.length > 0 && !paramOf(SDK_TOOLS_PARAM)) {
    added[SDK_TOOLS_PARAM] = toolsParam(uncovered);
    sources[SDK_TOOLS_PARAM] = bindings[SDK_TOOLS_PARAM] = { kind: "tools" };
  }
  const coveredSkills = new Set<string>();
  for (const [name, param] of Object.entries(sandbox.params)) {
    if (param.kind !== "tools" || bindings[name]?.kind === "tools") continue;
    const listed = param.default.filter((t) => capture.skills.some((r) => r.id === t.name));
    if (listed.length === 0) continue;
    for (const t of listed) coveredSkills.add(t.name);
    if (!bindings[name]) bindings[name] = { kind: "skills" };
  }
  const freeSkills = capture.skills.filter((s) => !coveredSkills.has(s.id));
  if (freeSkills.length > 0 && !paramOf(SDK_SKILLS_PARAM)) {
    added[SDK_SKILLS_PARAM] = skillsParam(freeSkills);
    sources[SDK_SKILLS_PARAM] = bindings[SDK_SKILLS_PARAM] = { kind: "skills" };
  }
  if (Object.keys(added).length === 0 && Object.keys(bindings).length === known) return sandbox;
  return Object.freeze({
    ...sandbox,
    params: { ...sandbox.params, ...added } as ParamMap,
    sdkParams: { ...sandbox.sdkParams, ...sources },
    sdkBindings: bindings,
  });
}

/** Every param bound to an SDK read: the sdk params, and the declared params that won a clash. */
export function bindingsOf(sandbox: Sandbox): Readonly<Record<string, SdkParamSource>> {
  return sandbox.sdkBindings ?? sandbox.sdkParams ?? {};
}

function catalogParam(read: CatalogRead): Param | null {
  const baseline = read.catalog ?? read.default;
  const param = read.kind === "prompt" ? prompt(baseline) : model(baseline);
  return checkParamValue(param, param.default) ? null : param;
}

/** The SDK tools as a tools param. Hints come from MCP-style `annotations` on the tool. */
function toolsParam(registered: readonly RegisteredTool[]) {
  const toolset: Record<string, object> = {};
  const hints: Record<string, ToolHints> = {};
  for (const { id, description, inputSchema, tool } of registered) {
    const object = (typeof tool === "object" && tool !== null ? tool : {}) as Record<
      string,
      unknown
    >;
    toolset[id] = { inputSchema, ...object, description };
    hints[id] = hintsOf(object.annotations);
  }
  return tools(toolset, hints);
}

/**
 * The SDK skills as a tools-shaped param: one row per skill (enabled, description, mode).
 * A row's execute loads the skill through the loader `ratel.skills()` hands it.
 */
function skillsParam(registered: readonly RegisteredSkill[]) {
  const toolset: Record<string, object> = {};
  const hints: Record<string, ToolHints> = {};
  for (const { id, description, skill } of registered) {
    const annotations = (skill as { annotations?: unknown } | null | undefined)?.annotations;
    toolset[id] = {
      description,
      inputSchema: { type: "object", properties: {} },
      execute: (_args: unknown, options?: { ratelLoad?: () => Promise<string> }) =>
        options?.ratelLoad?.() ?? "",
    };
    hints[id] = hintsOf(annotations);
  }
  return tools(toolset, hints);
}

function hintsOf(annotations: unknown): ToolHints {
  const a = (typeof annotations === "object" && annotations !== null ? annotations : {}) as {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
  };
  if (a.readOnlyHint === true) return { readOnly: true };
  if (a.destructiveHint === true) return { sideEffect: true };
  return {};
}
