import { TwinInputError } from "./errors.js";
import type { ParamMap, ParamValues } from "./params.js";
import { resolveParams, settleParams } from "./resolve.js";
import {
  resolveToolModes,
  type ToolChannel,
  type ToolDescriptor,
  type ToolMode,
  type ToolsParam,
  wrapTools,
} from "./tools.js";
import {
  checkInput,
  type LogLevel,
  type ResolveContext,
  type Twin,
  type TwinEventPayload,
} from "./twin.js";

export interface RunTwinOptions<I> {
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
  /** Where the twin's resolver imports packages from. The runner passes the twin file. */
  readonly resolveContext?: ResolveContext;
}

export interface RunTwinResult<O> {
  readonly output: O;
  readonly configHash: string;
  readonly overrides: readonly string[];
  /** The mode each tool ran in. */
  readonly toolModes: Readonly<Record<string, ToolMode>>;
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
  const toolsParams = Object.entries(twin.params).filter(
    (entry): entry is [string, ToolsParam] => entry[1].kind === "tools",
  );
  const descriptors: ToolDescriptor[] = toolsParams.flatMap(([, param]) => param.default);
  const toolModes = resolveToolModes(twin.id, descriptors, options.toolModes);
  const resolved = resolveParams(twin, options.overrides ?? {}, options.resolveContext);
  const params: Record<string, unknown> = await settleParams(resolved.values);
  const signal = options.signal ?? new AbortController().signal;
  for (const [name, param] of toolsParams) {
    params[name] = wrapTools({
      twinId: twin.id,
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
  const output = await twin.run({
    input: options.input,
    params: params as ParamValues<P, M>,
    ctx: {
      twinId: twin.id,
      context: { ...twin.context, ...options.context },
      signal,
      log: (message, level = "info") => options.onLog?.(String(message), level),
      textDelta: (text) => {
        if (text !== "") options.onText?.(String(text));
      },
    },
  });
  return { output, configHash: resolved.configHash, overrides: resolved.overrides, toolModes };
}
