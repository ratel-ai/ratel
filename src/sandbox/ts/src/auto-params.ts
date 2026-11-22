import type { CatalogRead, RegisteredTool, SetupCapture } from "./catalog.js";
import { checkParamValue, model, type Param, type ParamMap, prompt } from "./params.js";
import { PARAM_NAME, type Sandbox, type SdkParamSource } from "./sandbox.js";
import { type ToolHints, tools } from "./tools.js";

/** The name of the param that holds the tools registered on the SDK. */
export const SDK_TOOLS_PARAM = "tools";

/**
 * Adds the params that come from the SDK to a sandbox: each prompt and model the code
 * read through the catalog (named by its catalog id) and the tools registered on a
 * `ratel()` core (one `tools` param). A param the sandbox already has wins on a name
 * clash: a declared param, or an sdk param added before. Returns the same sandbox when
 * the capture adds nothing, so a runner can tell when its manifest changed.
 *
 * A catalog id that is not a valid param name, or a default that is not a valid value
 * (a model id without `provider/`), is skipped. Skills are not params yet.
 */
export function withSdkParams<S extends Sandbox>(sandbox: S, capture: SetupCapture): S {
  const added: Record<string, Param> = {};
  const sources: Record<string, SdkParamSource> = {};
  const taken = (name: string) => Object.hasOwn(sandbox.params, name) || Object.hasOwn(added, name);
  for (const read of capture.reads) {
    const param = catalogParam(read);
    if (!param || !PARAM_NAME.test(read.id) || taken(read.id)) continue;
    added[read.id] = param;
    sources[read.id] = { kind: read.kind, id: read.id };
  }
  if (capture.tools.length > 0 && !taken(SDK_TOOLS_PARAM)) {
    added[SDK_TOOLS_PARAM] = toolsParam(capture.tools);
    sources[SDK_TOOLS_PARAM] = { kind: "tools" };
  }
  if (Object.keys(added).length === 0) return sandbox;
  return Object.freeze({
    ...sandbox,
    params: { ...sandbox.params, ...added } as ParamMap,
    sdkParams: { ...sandbox.sdkParams, ...sources },
  });
}

function catalogParam(read: CatalogRead): Param | null {
  const param = read.kind === "prompt" ? prompt(read.default) : model(read.default);
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

function hintsOf(annotations: unknown): ToolHints {
  const a = (typeof annotations === "object" && annotations !== null ? annotations : {}) as {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
  };
  if (a.readOnlyHint === true) return { readOnly: true };
  if (a.destructiveHint === true) return { sideEffect: true };
  return {};
}
