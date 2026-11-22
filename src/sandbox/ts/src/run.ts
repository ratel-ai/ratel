import { bindingsOf } from "./auto-params.js";
import { type CatalogOverrides, type CatalogRead, withCatalogRun } from "./catalog.js";
import { SandboxInputError } from "./errors.js";
import type { ParamMap, ParamValues } from "./params.js";
import { resolveParams, settleParams } from "./resolve.js";
import {
  checkInput,
  type LogLevel,
  type ResolveContext,
  type Sandbox,
  type TwinEventPayload,
} from "./sandbox.js";
import {
  resolveToolModes,
  type ToolChannel,
  type ToolDescriptor,
  type ToolMode,
  type ToolsParam,
  wrapTools,
} from "./tools.js";

export interface RunSandboxOptions<I> {
  readonly input: I;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** Receives each `ctx.log` line. */
  readonly onLog?: (message: string, level: LogLevel) => void;
  /** Receives each `ctx.textDelta` piece. */
  readonly onText?: (text: string) => void;
  /** Mode per tool name. A tool not named runs in the default mode of its hint. */
  readonly toolModes?: Readonly<Record<string, string>>;
  /** Answers fake and confirm calls. Absent: a fake call fails and a confirm call is rejected. */
  readonly toolChannel?: ToolChannel;
  /** Receives each `tool.call` and `tool.result` event. */
  readonly onEvent?: (payload: TwinEventPayload) => void;
  /** Default: 10 minutes. */
  readonly confirmTimeoutMs?: number;
  /** Where the sandbox's resolver imports packages from. The runner passes the sandbox file. */
  readonly resolveContext?: ResolveContext;
  /** Prompt and model values that the experimental SDK catalog serves to this run, by catalog id. */
  readonly catalogOverrides?: CatalogOverrides;
}

export interface RunSandboxResult<O> {
  readonly output: O;
  readonly configHash: string;
  readonly overrides: readonly string[];
  /** The mode each tool ran in. */
  readonly toolModes: Readonly<Record<string, ToolMode>>;
  /** The prompts and models the run's code read through the experimental SDK catalog. */
  readonly catalogReads: readonly CatalogRead[];
}

/**
 * One run: checks the input against the sandbox's input kind, resolves the params
 * for this run only, then calls the sandbox's run(). A chat run gets the
 * conversation so far in `input.messages`.
 */
export async function runSandbox<P extends ParamMap, I, O, M>(
  sandbox: Sandbox<P, I, O, M>,
  options: RunSandboxOptions<I>,
): Promise<RunSandboxResult<O>> {
  const problem = checkInput(sandbox.input, options.input);
  if (problem) throw new SandboxInputError(sandbox.id, problem);
  const toolsParams = Object.entries(sandbox.params).filter(
    (entry): entry is [string, ToolsParam] => entry[1].kind === "tools",
  );
  const descriptors: ToolDescriptor[] = toolsParams.flatMap(([, param]) => param.default);
  const toolModes = resolveToolModes(sandbox.id, descriptors, options.toolModes);
  const resolved = resolveParams(sandbox, options.overrides ?? {}, options.resolveContext);
  const params: Record<string, unknown> = await settleParams(resolved.values);
  const signal = options.signal ?? new AbortController().signal;
  for (const [name, param] of toolsParams) {
    params[name] = wrapTools({
      sandboxId: sandbox.id,
      param,
      toolset: params[name] as Parameters<typeof wrapTools>[0]["toolset"],
      modes: toolModes,
      signal,
      ...(options.toolChannel ? { channel: options.toolChannel } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.confirmTimeoutMs !== undefined
        ? { confirmTimeoutMs: options.confirmTimeoutMs }
        : {}),
    });
  }
  const sdk = sdkRunValues(sandbox, resolved, params, options.catalogOverrides);
  const { result: output, reads } = await withCatalogRun(
    sdk.overrides,
    () =>
      sandbox.run({
        input: options.input,
        params: params as ParamValues<P, M>,
        ctx: {
          sandboxId: sandbox.id,
          context: { ...sandbox.context, ...options.context },
          signal,
          log: (message, level = "info") => options.onLog?.(String(message), level),
          textDelta: (text) => {
            if (text !== "") options.onText?.(String(text));
          },
        },
      }),
    sdk.toolset,
  );
  return {
    output,
    configHash: resolved.configHash,
    overrides: resolved.overrides,
    toolModes,
    catalogReads: reads,
  };
}

/**
 * What the catalog host serves a run: the value of each prompt and model bound to an SDK
 * read, and the run's version of the bound tools. An sdk prompt or model is served only
 * when the run changes it: its default is the catalog baseline, which the code reads by
 * itself. A declared one that won a clash is always served: its value is the sandbox's.
 */
function sdkRunValues(
  sandbox: Sandbox<ParamMap, unknown, unknown, unknown>,
  resolved: {
    readonly raw: Readonly<Record<string, unknown>>;
    readonly overrides: readonly string[];
  },
  params: Readonly<Record<string, unknown>>,
  extra: CatalogOverrides | undefined,
): { overrides: CatalogOverrides; toolset?: <T>(tools: T) => T } {
  const prompts: Record<string, string> = { ...extra?.prompts };
  const models: Record<string, string> = { ...extra?.models };
  const served = new Map<string, unknown>();
  const bound = new Set<string>();
  for (const [name, source] of Object.entries(bindingsOf(sandbox))) {
    if (source.kind === "tools") {
      const param = sandbox.params[name];
      if (param?.kind !== "tools") continue;
      const runTools = params[name] as Readonly<Record<string, unknown>>;
      for (const { name: tool } of param.default) {
        bound.add(tool);
        if (Object.hasOwn(runTools, tool)) served.set(tool, runTools[tool]);
      }
      continue;
    }
    const sdk = sandbox.sdkParams && Object.hasOwn(sandbox.sdkParams, name);
    if (sdk && !resolved.overrides.includes(name)) continue;
    const value = resolved.raw[name] as string;
    if (source.kind === "prompt") prompts[source.id] = value;
    else models[source.id] = value;
  }
  const overrides = { prompts, models };
  if (bound.size === 0) return { overrides };
  // The code's toolset, with each bound tool swapped for its run version; a disabled one is left out.
  const toolset = <T>(tools: T): T => {
    const out: Record<string, unknown> = {};
    for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
      if (!bound.has(name)) out[name] = tool;
      else if (served.has(name)) out[name] = served.get(name);
    }
    return out as T;
  };
  return { overrides, toolset };
}
