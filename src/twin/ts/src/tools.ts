import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { TwinEventPayload } from "./twin.js";

// The tools param (spec §3.4, §3.6). `twin.tools(defaults.tools, hints)` keeps
// the production toolset and describes each tool as plain data. Per run it
// returns a toolset of the same shape: edited descriptions applied, disabled
// tools removed and each `execute` wrapped by its mode. It reads AI SDK tools
// structurally ({ description, inputSchema, execute }), so it never imports `ai`.

export type ToolMode = "real" | "fake" | "confirm";
export type ToolHint = "readOnly" | "sideEffect" | "none";
export type FakeSource = "pinned" | "recorded" | "generated";
export type ConfirmDecision = "approve" | "edit" | "fake" | "reject";

/** The hints of one tool in the twin file. They set its default mode. */
export interface ToolHints {
  /** Reads only: runs real by default. */
  readonly readOnly?: boolean;
  /** Changes something outside the run: faked by default, never real without allowReal. */
  readonly sideEffect?: boolean;
  /** Lets a sideEffect tool run real. Only the twin file can set it. */
  readonly allowReal?: boolean;
  /** A meta-tool or sub-agent: the mode applies to the whole outer call. */
  readonly opaque?: boolean;
}

/** One tool as plain data: the manifest `tools` param lists these. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly hint: ToolHint;
  readonly allowReal?: boolean;
  readonly opaque?: boolean;
}

/** One entry of a per-run override of a tools param: a changed description, or a disabled tool. */
export interface ToolEdit {
  readonly name: string;
  readonly description?: string;
  readonly enabled?: boolean;
}

/** A tools param. `T` is the production toolset type; run() gets a value of the same type. */
export interface ToolsParam<T = unknown> {
  readonly kind: "tools";
  readonly default: readonly ToolDescriptor[];
  readonly description?: string;
  /** Type-level marker of the value type. Never set at runtime. */
  readonly __value?: T;
}

/** The answer to a tool.fake.request. */
export interface FakeAnswer {
  readonly result: unknown;
  readonly isError: boolean;
  readonly source: FakeSource;
}

/** The answer to a tool.confirm.request. */
export interface ConfirmAnswer {
  readonly decision: ConfirmDecision;
  /** The edited arguments (edit). */
  readonly args?: unknown;
  /** The fake value (fake). */
  readonly result?: unknown;
}

export interface FakeRequest {
  readonly callId: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly args: unknown;
  /** Up to the last 6 messages of the conversation, as the AI SDK passed them to execute. */
  readonly messages: readonly unknown[];
}

export interface ConfirmRequest {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
}

/**
 * Where a run's fake and confirm calls go: the playground (through `ratel dev`)
 * or the local CLI. Each call resolves with the answer or rejects.
 */
export interface ToolChannel {
  fake(request: FakeRequest, signal: AbortSignal): Promise<FakeAnswer>;
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmAnswer>;
}

/** Thrown for a tool modes request the twin does not allow. Maps to run.reject `invalid_params`. */
export class ToolModeError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly twinId: string,
    readonly problems: readonly string[],
  ) {
    super(`${twinId}: toolModes ${problems.join("; ")}`);
    this.name = "ToolModeError";
  }
}

/** The result a rejected confirm gives the model. */
export const REJECTED_RESULT = Object.freeze({ error: "Rejected by reviewer" });
/** No decision within this time rejects the call (spec §8). */
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
/** How many of the last messages go with a fake request. */
export const FAKE_CONTEXT_MESSAGES = 6;

export const RATEL_TOOL_MODE = "ratel.tool.mode";
export const RATEL_TOOL_FAKE_SOURCE = "ratel.tool.fake.source";
export const RATEL_TOOL_CONFIRM_DECISION = "ratel.tool.confirm.decision";
const EXECUTE_TOOL = "execute_tool";

/** The production tools behind a tools param, kept off the plain-data param. */
const toolsets = new WeakMap<ToolsParam, Readonly<Record<string, AnyTool>>>();
/** Schemas that only an async conversion can describe, filled in by prepareTools. */
const pendingSchemas = new WeakMap<ToolsParam, Promise<void>>();

interface AnyTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly execute?: (args: unknown, options?: ToolCallOptions) => unknown;
  readonly [key: string]: unknown;
}

interface ToolCallOptions {
  readonly toolCallId?: string;
  readonly messages?: readonly unknown[];
  readonly abortSignal?: AbortSignal;
  readonly [key: string]: unknown;
}

/**
 * Declares the tools param: the production toolset and a hint per tool. A tool
 * with no hint defaults to confirm. `T` stays the toolset type, so run() can
 * hand the per-run toolset to `streamText` with no cast.
 */
export function tools<T extends object>(
  toolset: T,
  hints: { readonly [K in keyof T]?: ToolHints } = {},
  opts: { description?: string } = {},
): ToolsParam<T> {
  const byName = toolset as Readonly<Record<string, AnyTool>>;
  const pending: Promise<void>[] = [];
  const descriptors = Object.entries(byName).map(([name, tool]) => {
    const hint = (hints as Record<string, ToolHints | undefined>)[name] ?? {};
    if (hint.readOnly && hint.sideEffect)
      throw new TypeError(`tool ${name}: readOnly and sideEffect cannot both be set`);
    const descriptor: { -readonly [K in keyof ToolDescriptor]: ToolDescriptor[K] } = {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      hint: hint.readOnly ? "readOnly" : hint.sideEffect ? "sideEffect" : "none",
      ...(hint.sideEffect ? { allowReal: hint.allowReal === true } : {}),
      ...(hint.opaque ? { opaque: true } : {}),
    };
    for (const field of ["inputSchema", "outputSchema"] as const) {
      const schema = jsonSchemaOf(tool[field]);
      if (schema instanceof Promise) pending.push(schema.then((s) => assign(descriptor, field, s)));
      else assign(descriptor, field, schema);
    }
    return descriptor;
  });
  for (const name of Object.keys(hints)) {
    if (!Object.hasOwn(byName, name)) throw new TypeError(`tool hint for unknown tool "${name}"`);
  }
  const param: ToolsParam<T> = {
    kind: "tools",
    default: descriptors,
    ...(opts.description ? { description: opts.description } : {}),
  };
  toolsets.set(param, byName);
  if (pending.length > 0)
    pendingSchemas.set(
      param,
      Promise.all(pending).then(() => {}),
    );
  return param;
}

/** Waits for tool schemas that need an async conversion, so the manifest can list them. */
export async function prepareTools(params: Iterable<unknown>): Promise<void> {
  await Promise.all([...params].map((p) => (isToolsParam(p) ? pendingSchemas.get(p) : undefined)));
}

export function isToolsParam(value: unknown): value is ToolsParam {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "tools"
  );
}

/** The mode of each tool for one run: the requested mode, else the default of its hint. */
export function resolveToolModes(
  twinId: string,
  descriptors: readonly ToolDescriptor[],
  requested: Readonly<Record<string, string>> = {},
): Record<string, ToolMode> {
  const problems = toolModeProblems(descriptors, requested);
  if (problems.length > 0) throw new ToolModeError(twinId, problems);
  const modes: Record<string, ToolMode> = {};
  for (const tool of descriptors) {
    modes[tool.name] = (requested[tool.name] as ToolMode | undefined) ?? defaultMode(tool);
  }
  return modes;
}

/** Why a toolModes request is not allowed: unknown tools, bad modes, real side effects. */
export function toolModeProblems(
  descriptors: readonly ToolDescriptor[],
  requested: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const [name, mode] of Object.entries(requested)) {
    const tool = descriptors.find((d) => d.name === name);
    if (!tool) problems.push(`${name}: is an unknown tool`);
    else if (mode !== "real" && mode !== "fake" && mode !== "confirm")
      problems.push(`${name}: mode must be real, fake or confirm`);
    else if (mode === "real" && tool.hint === "sideEffect" && tool.allowReal !== true)
      problems.push(`${name}: real needs allowReal: true in the twin file`);
  }
  return problems;
}

export function defaultMode(tool: ToolDescriptor): ToolMode {
  return tool.hint === "readOnly" ? "real" : tool.hint === "sideEffect" ? "fake" : "confirm";
}

/** Why a tools override does not fit the param, or null. It can edit and disable, never add. */
export function checkToolsValue(param: ToolsParam, value: unknown): string | null {
  if (!Array.isArray(value)) return "must be an array of tools";
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return "must be an array of tools";
    const { name, description, enabled } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !param.default.some((t) => t.name === name))
      return `has an unknown tool ${JSON.stringify(name)}`;
    if (seen.has(name)) return `lists ${name} twice`;
    seen.add(name);
    if (description !== undefined && typeof description !== "string")
      return `${name}: description must be a string`;
    if (enabled !== undefined && typeof enabled !== "boolean")
      return `${name}: enabled must be true or false`;
  }
  return null;
}

/**
 * The tools as the config hash sees them: name and description of each enabled
 * tool, in declaration order. Modes are not in it. The same form for the
 * production toolset (hashableTools) and for the param's descriptors.
 */
export function toolsHashValue(
  param: ToolsParam,
  override?: readonly ToolEdit[],
): { name: string; description: string }[] {
  return enabledTools(param, override).map(({ name, description }) => ({ name, description }));
}

/** The hash form of a production toolset value, or undefined when `value` is not a toolset. */
export function hashableTools(value: unknown): { name: string; description: string }[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const isToolset =
    entries.length > 0 &&
    entries.every(
      ([, t]) =>
        typeof t === "object" &&
        t !== null &&
        ("inputSchema" in t || typeof (t as AnyTool).execute === "function"),
    );
  if (!isToolset) return undefined;
  return entries.map(([name, t]) => ({
    name,
    description:
      typeof (t as AnyTool).description === "string" ? String((t as AnyTool).description) : "",
  }));
}

/** The production toolset with the run's edits: changed descriptions, disabled tools removed. */
export function editedToolset(
  param: ToolsParam,
  override?: readonly ToolEdit[],
): Record<string, AnyTool> {
  const production = toolsets.get(param) ?? {};
  const out: Record<string, AnyTool> = {};
  for (const { name, description } of enabledTools(param, override)) {
    const tool = production[name];
    if (tool) out[name] = { ...tool, description };
  }
  return out;
}

export interface WrapToolsOptions {
  readonly twinId: string;
  readonly param: ToolsParam;
  readonly toolset: Readonly<Record<string, AnyTool>>;
  readonly modes: Readonly<Record<string, ToolMode>>;
  readonly channel?: ToolChannel;
  readonly signal: AbortSignal;
  readonly onEvent?: (payload: TwinEventPayload) => void;
  readonly confirmTimeoutMs?: number;
}

/** Wraps each tool's execute by its mode for one run. Tools without execute stay as they are. */
export function wrapTools(options: WrapToolsOptions): Record<string, AnyTool> {
  const out: Record<string, AnyTool> = {};
  let n = 0;
  for (const [name, tool] of Object.entries(options.toolset)) {
    const descriptor = options.param.default.find((d) => d.name === name);
    if (!descriptor || typeof tool.execute !== "function") {
      out[name] = tool;
      continue;
    }
    const mode = options.modes[name] ?? defaultMode(descriptor);
    const call = new ToolCall(
      options,
      { ...descriptor, description: tool.description ?? "" },
      tool,
      mode,
    );
    out[name] = {
      ...tool,
      execute: (args: unknown, callOptions?: ToolCallOptions) =>
        call.run(args, callOptions ?? {}, callOptions?.toolCallId ?? `call_${++n}`),
    };
  }
  return out;
}

class ToolCall {
  constructor(
    private readonly options: WrapToolsOptions,
    private readonly descriptor: ToolDescriptor,
    private readonly tool: AnyTool,
    private readonly mode: ToolMode,
  ) {}

  async run(args: unknown, callOptions: ToolCallOptions, callId: string): Promise<unknown> {
    const { name } = this.descriptor;
    this.emit({ kind: "tool.call", callId, tool: name, args, mode: this.mode });
    return withToolSpan(name, callId, async (span) => {
      span.setAttribute(RATEL_TOOL_MODE, this.mode);
      const outcome = await this.#outcome(args, callOptions, callId, span).catch(
        (err: unknown): Outcome => ({ result: messageOf(err), isError: true }),
      );
      this.emit({
        kind: "tool.result",
        callId,
        result: outcome.result,
        isError: outcome.isError,
        mode: this.mode,
        ...(outcome.fakeSource ? { fakeSource: outcome.fakeSource } : {}),
        ...(outcome.decision ? { confirmDecision: outcome.decision } : {}),
      });
      if (outcome.fakeSource) span.setAttribute(RATEL_TOOL_FAKE_SOURCE, outcome.fakeSource);
      if (outcome.decision) span.setAttribute(RATEL_TOOL_CONFIRM_DECISION, outcome.decision);
      if (outcome.isError) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(outcome.result) });
        throw outcome.error ?? new Error(stringify(outcome.result));
      }
      return outcome.result;
    });
  }

  async #outcome(
    args: unknown,
    callOptions: ToolCallOptions,
    callId: string,
    span: Span,
  ): Promise<Outcome> {
    switch (this.mode) {
      case "real":
        return this.#real(args, callOptions);
      case "fake": {
        const invalid = await validateArgs(this.tool.inputSchema, args);
        if (invalid)
          return {
            result: `Invalid arguments for ${this.descriptor.name}: ${invalid}`,
            isError: true,
          };
        return this.#fake(args, callOptions, callId);
      }
      case "confirm":
        return this.#confirm(args, callOptions, callId, span);
    }
  }

  async #real(args: unknown, callOptions: ToolCallOptions): Promise<Outcome> {
    if (this.descriptor.hint === "sideEffect" && this.descriptor.allowReal !== true) {
      // Defense in depth: resolveToolModes already refuses this mode.
      return {
        result: `${this.descriptor.name} cannot run real: set allowReal: true in the twin file`,
        isError: true,
      };
    }
    try {
      return { result: await this.tool.execute?.(args, callOptions), isError: false };
    } catch (err) {
      return { result: messageOf(err), isError: true, error: err };
    }
  }

  async #fake(args: unknown, callOptions: ToolCallOptions, callId: string): Promise<Outcome> {
    const channel = this.options.channel;
    if (!channel) {
      return { result: `no fake source for ${this.descriptor.name} in this run`, isError: true };
    }
    const answer = await channel.fake(
      {
        callId,
        tool: this.descriptor.name,
        description: this.descriptor.description,
        ...(this.descriptor.inputSchema ? { inputSchema: this.descriptor.inputSchema } : {}),
        ...(this.descriptor.outputSchema ? { outputSchema: this.descriptor.outputSchema } : {}),
        args,
        messages: (callOptions.messages ?? []).slice(-FAKE_CONTEXT_MESSAGES),
      },
      this.options.signal,
    );
    return { result: answer.result, isError: answer.isError, fakeSource: answer.source };
  }

  async #confirm(
    args: unknown,
    callOptions: ToolCallOptions,
    callId: string,
    span: Span,
  ): Promise<Outcome> {
    const answer = await this.#decision(callId, args);
    span.setAttribute(RATEL_TOOL_CONFIRM_DECISION, answer.decision);
    switch (answer.decision) {
      case "reject":
        return { result: REJECTED_RESULT, isError: false, decision: "reject" };
      case "fake":
        return { result: answer.result, isError: false, decision: "fake", fakeSource: "pinned" };
      case "approve":
      case "edit": {
        const finalArgs = answer.decision === "edit" ? answer.args : args;
        const invalid = await validateArgs(this.tool.inputSchema, finalArgs);
        if (invalid) {
          return {
            result: `Invalid arguments for ${this.descriptor.name}: ${invalid}`,
            isError: true,
            decision: answer.decision,
          };
        }
        return { ...(await this.#real(finalArgs, callOptions)), decision: answer.decision };
      }
    }
  }

  /** The reviewer's decision. No channel, a failure or no answer in time: reject. */
  async #decision(callId: string, args: unknown): Promise<ConfirmAnswer> {
    const channel = this.options.channel;
    if (!channel) return { decision: "reject" };
    const timeoutMs = this.options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    const abort = new AbortController();
    const onRunAbort = () => abort.abort(this.options.signal.reason);
    this.options.signal.addEventListener("abort", onRunAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ConfirmAnswer>((resolve) => {
      timer = setTimeout(() => {
        abort.abort(new Error("no decision in time"));
        resolve({ decision: "reject" });
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        channel.confirm({ callId, tool: this.descriptor.name, args }, abort.signal),
        timeout,
      ]);
    } catch {
      return { decision: "reject" };
    } finally {
      clearTimeout(timer);
      this.options.signal.removeEventListener("abort", onRunAbort);
    }
  }

  emit(payload: TwinEventPayload): void {
    this.options.onEvent?.(payload);
  }
}

interface Outcome {
  readonly result: unknown;
  readonly isError: boolean;
  readonly error?: unknown;
  readonly fakeSource?: FakeSource;
  readonly decision?: ConfirmDecision;
}

/**
 * Runs `body` on the `execute_tool <tool>` span. When the AI SDK already made
 * that span (it is active), the mode attributes go on it; else this makes one.
 */
async function withToolSpan<T>(
  tool: string,
  callId: string,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  const active = trace.getActiveSpan();
  if (active && (active as unknown as { name?: unknown }).name === `${EXECUTE_TOOL} ${tool}`)
    return body(active);
  const attributes: Attributes = {
    "gen_ai.operation.name": EXECUTE_TOOL,
    "gen_ai.tool.name": tool,
    "gen_ai.tool.call.id": callId,
  };
  return trace
    .getTracer("@ratel-ai/twin")
    .startActiveSpan(`${EXECUTE_TOOL} ${tool}`, { attributes }, async (span) => {
      try {
        return await body(span);
      } finally {
        span.end();
      }
    });
}

/** Why `args` do not fit the tool's schema, or null. Standard Schema (zod) or an AI SDK Schema. */
async function validateArgs(schema: unknown, args: unknown): Promise<string | null> {
  if (typeof schema !== "object" || schema === null) return null;
  const standard = (schema as { "~standard"?: { validate?: (v: unknown) => unknown } })[
    "~standard"
  ];
  if (typeof standard?.validate === "function") {
    const result = (await standard.validate(args)) as {
      issues?: readonly { message: string; path?: readonly unknown[] }[];
    };
    if (!result.issues?.length) return null;
    return result.issues
      .map((i) => (i.path?.length ? `${i.path.map(pathKey).join(".")}: ${i.message}` : i.message))
      .join("; ");
  }
  const validate = (schema as { validate?: (v: unknown) => unknown }).validate;
  if (typeof validate === "function") {
    const result = (await validate.call(schema, args)) as { success: boolean; error?: unknown };
    return result.success ? null : messageOf(result.error);
  }
  return null;
}

/** The JSON Schema of an AI SDK schema: a `jsonSchema()` wrapper, a Standard Schema or plain JSON. */
function jsonSchemaOf(
  schema: unknown,
):
  | Readonly<Record<string, unknown>>
  | undefined
  | Promise<Readonly<Record<string, unknown>> | undefined> {
  if (typeof schema !== "object" || schema === null) return undefined;
  const wrapped = (schema as { jsonSchema?: unknown }).jsonSchema;
  if (wrapped !== undefined && typeof wrapped !== "function") {
    return isThenable(wrapped) ? Promise.resolve(wrapped).then(asObject) : asObject(wrapped);
  }
  const standard = (
    schema as { "~standard"?: { jsonSchema?: { input?: (o: object) => unknown } } }
  )["~standard"];
  if (typeof standard?.jsonSchema?.input === "function") {
    try {
      return asObject(standard.jsonSchema.input({ target: "draft-07" }));
    } catch {
      return undefined;
    }
  }
  return "type" in schema || "properties" in schema ? asObject(schema) : undefined;
}

function enabledTools(param: ToolsParam, override?: readonly ToolEdit[]): ToolDescriptor[] {
  if (!override) return [...param.default];
  return param.default.flatMap((tool) => {
    const edit = override.find((e) => e.name === tool.name);
    if (!edit || edit.enabled === false) return [];
    return [{ ...tool, description: edit.description ?? tool.description }];
  });
}

function assign(target: Record<string, unknown>, field: string, value: unknown): void {
  if (value !== undefined) target[field] = value;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
    : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function pathKey(key: unknown): string {
  return typeof key === "object" && key !== null && "key" in key ? String(key.key) : String(key);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
