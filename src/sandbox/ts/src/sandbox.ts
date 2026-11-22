import {
  type ImageSpec,
  imageProblem,
  SANDBOX_STATES,
  type SandboxOutput,
  type SandboxState,
} from "./image.js";
import { checkParamValue, type ParamMap, type ParamValues } from "./params.js";
import type { CallableProvider } from "./providers.js";
import type { FakeAnswer, FakeRequest } from "./tools.js";

/** The input of a structured sandbox: one JSON object described by a JSON Schema. */
export interface StructuredInput<I> {
  readonly kind: "structured";
  readonly schema: Readonly<Record<string, unknown>>;
  /** Type-level marker of the input type. Never set at runtime. */
  readonly __input?: I;
}

/**
 * The input of a chat sandbox: the conversation so far, ending with the user turn
 * under test. One run per user turn. `I` is `{ messages: Message[] }`.
 */
export interface ChatInput<I = ChatRunInput> {
  readonly kind: "chat";
  /** Type-level marker of the input type. Never set at runtime. */
  readonly __input?: I;
}

export interface ChatRunInput<M = ChatMessage> {
  readonly messages: M[];
}

/** The smallest message shape a chat input accepts. AI SDK sandboxes use `ModelMessage`. */
export interface ChatMessage {
  readonly role: string;
  readonly content: unknown;
}

export type SandboxInput<I> = StructuredInput<I> | ChatInput<I>;

/** Where a run resolves its packages from: the runner passes the sandbox file. */
export interface ResolveContext {
  /** Absolute path of the sandbox file. Its project's packages are the ones a resolver imports. */
  readonly from?: string;
}

/**
 * Maps a `provider/model` value to what run() gets. It can be async, for a
 * resolver that imports the provider package of the project at run time.
 */
export interface ModelResolver<M> {
  (modelId: string, context?: ResolveContext): M | PromiseLike<M>;
  /** Set by a built-in resolver: run() gets an AI SDK `LanguageModel`. */
  readonly modelKind?: "language-model";
  /** Set by a built-in resolver: the providers it can call with `env`. Key names only. */
  readonly callableProviders?: (
    env: Readonly<Record<string, string | undefined>>,
    context?: ResolveContext,
  ) => CallableProvider[];
  /** Set by a built-in resolver: generates a fake tool result with the user's key (local runs). */
  readonly generateFake?: (
    request: FakeRequest,
    signal: AbortSignal,
    context?: ResolveContext,
  ) => Promise<FakeAnswer>;
}

export interface RunContext {
  readonly sandboxId: string;
  /** Context values by name: fixed inputs that are not under test. */
  readonly context: Readonly<Record<string, unknown>>;
  /** Aborted when the run is canceled. */
  readonly signal: AbortSignal;
  /** Streams one log line to the playground as a `log` event. A no-op in a local run. */
  log(message: string, level?: LogLevel): void;
  /** Streams one piece of the reply to the playground as a `text.delta` event. */
  textDelta(text: string): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One event payload of a run, as it would leave the runner (protocol sandbox/v1 `run.event`). */
export type TwinEventPayload = { readonly kind: string } & Readonly<Record<string, unknown>>;

export interface SandboxDefinition<P extends ParamMap, I, O, M> {
  /**
   * The params Ratel can change per run. Absent: none declared. Tools registered on a
   * `ratel()` core and prompts and models read through `@ratel-ai/sdk/experimental/catalog`
   * become params by themselves (`source: "sdk"`); a declared param wins on a name clash.
   */
  readonly params?: P;
  readonly input: SandboxInput<I>;
  /** What run() returns: `sandbox.output(schema)` or `sandbox.text()`. Absent: not declared. */
  readonly output?: SandboxOutput<NoInfer<O>>;
  /** run (default): one instance per run. session: one instance kept across the turns of a session. */
  readonly state?: SandboxState;
  /** The image of a hosted instance: `sandbox.image({ base, install, copy, sidecars, env })`. */
  readonly image?: ImageSpec;
  /** Fixed inputs that are not under test, by name: see `sandbox.context()`. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Maps a `provider/model` value to what run() gets. Default: the bare model ID. */
  readonly resolve?: ModelResolver<M>;
  /**
   * The defaults object that production passes to `resolveLocal`. `ratel sandbox
   * verify` checks that a run with no overrides has its config hash. Never sent
   * to Ratel.
   */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** The input `ratel sandbox verify` uses when it gets no `--input`. Never sent to Ratel. */
  readonly example?: I;
  run(args: { input: I; params: ParamValues<P, M>; ctx: RunContext }): Promise<O> | O;
  /**
   * Runs on every event payload and on the run.end payload before they leave
   * the runner. Return a copy with sensitive values removed.
   */
  redact?(payload: TwinEventPayload): TwinEventPayload;
}

export interface Sandbox<P extends ParamMap = ParamMap, I = unknown, O = unknown, M = unknown>
  extends Omit<SandboxDefinition<P, I, O, M>, "output" | "params"> {
  readonly kind: "ratel.sandbox";
  readonly id: string;
  readonly params: P;
  /** The params that came from the SDK, not from the sandbox file, by param name. */
  readonly sdkParams?: Readonly<Record<string, SdkParamSource>>;
  /** Checked against run() in `sandbox()`. Untyped here, so a copy can change run(). */
  readonly output?: SandboxOutput<unknown>;
}

/** Where an sdk param comes from: a catalog read (prompt or model, by catalog id) or the registered tools. */
export type SdkParamSource =
  | { readonly kind: "prompt" | "model"; readonly id: string }
  | { readonly kind: "tools" };

const SANDBOX_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Declares a sandbox: the params Ratel can change, the input shape and the run function that calls the real code. */
export function defineSandbox<
  P extends ParamMap = Record<never, never>,
  I = unknown,
  O = unknown,
  M = string,
>(id: string, definition: SandboxDefinition<P, I, O, M>): Sandbox<P, I, O, M> {
  const params = (definition.params ?? {}) as P;
  if (!SANDBOX_ID.test(id))
    throw new TypeError(
      `"${id}" is not a valid sandbox id: use lowercase letters, digits, '.', '_' and '-'`,
    );
  for (const [name, param] of Object.entries(params)) {
    if (!PARAM_NAME.test(name)) throw new TypeError(`${id}: "${name}" is not a valid param name`);
    const problem = checkParamValue(param, param.default);
    if (problem) throw new TypeError(`${id}: ${name} default: ${problem}`);
  }
  for (const name of Object.keys(definition.context ?? {})) {
    if (!PARAM_NAME.test(name)) throw new TypeError(`${id}: "${name}" is not a valid context name`);
  }
  if (definition.state !== undefined && !SANDBOX_STATES.includes(definition.state))
    throw new TypeError(`${id}: state must be "run" or "session", not "${definition.state}"`);
  const imageIssue = definition.image ? imageProblem(definition.image) : null;
  if (imageIssue) throw new TypeError(`${id}: image: ${imageIssue}`);
  const output = definition.output;
  if (output && output.kind !== "text" && output.kind !== "structured")
    throw new TypeError(`${id}: output must come from sandbox.output() or sandbox.text()`);
  return Object.freeze({ kind: "ratel.sandbox", id, ...definition, params });
}

export function isSandbox(value: unknown): value is Sandbox {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "ratel.sandbox"
  );
}

export function structured<I>(schema: Readonly<Record<string, unknown>>): StructuredInput<I> {
  return { kind: "structured", schema };
}

/** A chat input: run() gets `{ messages }`, the conversation so far. One run per user turn. */
export function chat<M = ChatMessage>(): ChatInput<ChatRunInput<M>> {
  return { kind: "chat" };
}

/**
 * Declares the fixed inputs of a sandbox that are not under test (tenant, org,
 * user). The values are the defaults. A run can change them, never add one.
 */
export function context<C extends Readonly<Record<string, unknown>>>(values: C): Readonly<C> {
  return Object.freeze({ ...values });
}

/** Why `value` does not fit the sandbox's input kind, or null when it fits. */
export function checkInput(input: SandboxInput<unknown>, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "must be a JSON object";
  if (input.kind === "structured") return null;
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0)
    return "must have a non-empty messages array";
  const bad = messages.findIndex(
    (m) => typeof m !== "object" || m === null || typeof (m as ChatMessage).role !== "string",
  );
  return bad < 0 ? null : `messages[${bad}] must be an object with a string role`;
}
