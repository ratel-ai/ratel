import { bindingsOf } from "./auto-params.js";
import {
  type CatalogOverrides,
  type CatalogRead,
  type RunServe,
  type RunSkillView,
  type SkillView,
  withCatalogRun,
} from "./catalog.js";
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
  const sdk = sdkRunValues(sandbox, resolved, params, toolModes, options.catalogOverrides);
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
    sdk.serve,
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
  toolModes: Readonly<Record<string, ToolMode>>,
  extra: CatalogOverrides | undefined,
): { overrides: CatalogOverrides; serve: RunServe } {
  const prompts: Record<string, string> = { ...extra?.prompts };
  const models: Record<string, string> = { ...extra?.models };
  const tools = new BoundSet();
  const skills = new BoundSet();
  for (const [name, source] of Object.entries(bindingsOf(sandbox))) {
    if (source.kind === "tools" || source.kind === "skills") {
      const param = sandbox.params[name];
      if (param?.kind !== "tools") continue;
      (source.kind === "tools" ? tools : skills).add(param, params[name]);
      continue;
    }
    const sdk = sandbox.sdkParams && Object.hasOwn(sandbox.sdkParams, name);
    if (sdk && !resolved.overrides.includes(name)) continue;
    const value = resolved.raw[name] as string;
    if (source.kind === "prompt") prompts[source.id] = value;
    else models[source.id] = value;
  }
  const overrides = { prompts, models };
  const serve: { -readonly [K in keyof RunServe]: RunServe[K] } = {};
  if (tools.size > 0) {
    // The code's toolset, with each bound tool swapped for its run version; a disabled one is left out.
    serve.toolset = <T>(toolset: T): T => {
      const out: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(toolset as Record<string, unknown>)) {
        if (!tools.has(name)) out[name] = tool;
        else if (tools.served.has(name)) out[name] = tools.served.get(name);
      }
      return out as T;
    };
  }
  if (skills.size > 0) {
    // The run's view of each bound skill: absent when disabled, the run's description, a
    // load through the skill's mode. The SDK's SkillCatalog reads it (`skill`), and so
    // does the experimental `ratel.skills()` accessor (`skills`).
    const view = (id: string): RunSkillView | null | undefined => {
      if (!skills.has(id)) return undefined;
      const run = skills.served.get(id) as RunSkill | undefined;
      if (!run) return null;
      return {
        ...(typeof run.description === "string" ? { description: run.description } : {}),
        mode: toolModes[id] ?? "confirm",
        load: (readBody) => loadSkill(run, readBody),
      };
    };
    serve.skill = view;
    serve.skills = (list) =>
      list.flatMap((skill): SkillView[] => {
        const run = view(skill.id);
        if (run === undefined) return [skill];
        if (run === null) return [];
        return [
          {
            id: skill.id,
            description: run.description ?? skill.description,
            load: () => loadSkill(skills.served.get(skill.id) as RunSkill, skill.load),
          },
        ];
      });
  }
  return { overrides, serve };
}

interface RunSkill {
  readonly description?: unknown;
  readonly execute?: (args: unknown, options: Record<string, unknown>) => unknown;
}

/**
 * Loads a skill through the run's wrapped row: `real` calls `readBody`, `fake` returns
 * the fake value, `confirm` waits for the reviewer. A reject throws the reviewer's error.
 */
async function loadSkill(run: RunSkill, readBody: () => string | Promise<string>): Promise<string> {
  if (!run.execute) return readBody();
  const result = await run.execute({}, { messages: [], ratelLoad: async () => readBody() });
  if (typeof result === "string") return result;
  const error = (result as { error?: unknown } | null)?.error;
  if (typeof error === "string") throw new Error(error);
  return JSON.stringify(result);
}

/** The names a run binds to tools params, and the run's version of each enabled one. */
class BoundSet {
  readonly #names = new Set<string>();
  readonly served = new Map<string, unknown>();

  get size(): number {
    return this.#names.size;
  }

  has(name: string): boolean {
    return this.#names.has(name);
  }

  add(param: ToolsParam, value: unknown): void {
    const run = (value ?? {}) as Readonly<Record<string, unknown>>;
    for (const { name } of param.default) {
      this.#names.add(name);
      if (Object.hasOwn(run, name)) this.served.set(name, run[name]);
    }
  }
}
