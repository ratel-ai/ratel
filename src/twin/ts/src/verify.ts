import { randomBytes } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { DryModel } from "./dry-model.js";
import { localConfigHash, RATEL_TWIN_CONFIG_HASH, RATEL_TWIN_ID } from "./otel.js";
import { bareModelId, type ModelParam, type ParamMap, type ScalarParam } from "./params.js";
import { callableProviders } from "./providers.js";
import { runTwin } from "./run.js";
import {
  defaultMode,
  RATEL_TOOL_MODE,
  type ToolChannel,
  type ToolEdit,
  type ToolMode,
  type ToolsParam,
} from "./tools.js";
import type { ModelResolver, ResolveContext, Twin } from "./twin.js";

export { CAPTURE_CONTENT_ENV, installVerifyTracing, type VerifyTracing } from "./verify-tracing.js";

// `ratel twin verify` (spec §11 step 3): proves that each param of a twin
// reaches the model call. It runs the twin once with no overrides, then once
// per param with a sentinel override, and reads each run's spans from an
// in-memory span store. The sentinels never leave the process.

export type VerifyStatus = "wired" | "not_wired" | "skipped";

export interface VerifyRow {
  /** The param name, `<tools param>.<tool>` for the mode of one tool, or "config hash". */
  readonly param: string;
  readonly kind: string;
  readonly status: VerifyStatus;
  readonly detail: string;
}

export interface VerifyReport {
  readonly twinId: string;
  readonly rows: readonly VerifyRow[];
  /** False when a row is not wired. */
  readonly ok: boolean;
  /** How many times the twin ran. */
  readonly runs: number;
}

/** Where verify reads the spans of a run: an in-memory span processor. */
export interface SpanStore {
  spansOf(traceId: string): readonly ReadableSpan[];
}

type Env = Readonly<Record<string, string | undefined>>;

export interface VerifyOptions {
  readonly input: unknown;
  readonly spans: SpanStore;
  /** Read for key names, to find a second callable model. Default: `process.env`. */
  readonly env?: Env;
  /** The model the model check switches to. Default: a param option, else a built-in alternate. */
  readonly model?: string;
  /** Replaces the models of an AI SDK twin with a stand-in that makes no network call. */
  readonly dry?: boolean;
  readonly resolveContext?: ResolveContext;
  /** Answers fake tool calls. */
  readonly toolChannel?: ToolChannel;
  /** Called before each run with what it checks. */
  readonly onRun?: (label: string) => void;
  /** Makes the sentinel of a check. Default: a random token. */
  readonly sentinel?: (check: string) => string;
}

export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";

/** Scalar params whose value the model call records, by normalized name. */
export const REQUEST_ATTRIBUTES: Readonly<Record<string, string>> = {
  maxtokens: "gen_ai.request.max_tokens",
  maxoutputtokens: "gen_ai.request.max_tokens",
  temperature: "gen_ai.request.temperature",
  topp: "gen_ai.request.top_p",
  topk: "gen_ai.request.top_k",
};

/** A second model per provider, tried in order when a model param has no options. */
export const ALTERNATE_MODELS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"],
  google: ["google/gemini-3-flash", "google/gemini-3-pro"],
  openai: ["openai/gpt-5-mini", "openai/gpt-5"],
};

const NO_MODEL_SPAN =
  "no model-call span (with gen_ai.request.model) in the run: turn on the telemetry of the model call";

/**
 * Runs the twin once with no overrides and once per param with a sentinel
 * override, then reports per param if the override reached the model call.
 * Throws when the run with no overrides fails.
 */
export async function verifyTwin(twin: Twin, options: VerifyOptions): Promise<VerifyReport> {
  const subject = options.dry ? withDryModels(twin) : twin;
  const sentinel = options.sentinel ?? randomSentinel;
  const toolModes = verifyToolModes(twin.params);
  const records: RunRecord[] = [];
  const run = async (label: string, overrides: Record<string, unknown>) => {
    options.onRun?.(label);
    const record = await runOnce(subject, options, overrides, toolModes);
    records.push(record);
    return record;
  };

  const baseline = await run("no overrides", {});
  if (baseline.error)
    throw new Error(`${twin.id}: the run with no overrides failed: ${baseline.error}`);

  const rows: VerifyRow[] = [];
  for (const [name, param] of Object.entries(twin.params)) {
    switch (param.kind) {
      case "prompt":
        rows.push(await checkPrompt(name, param.default, sentinel(name), run));
        break;
      case "model":
        rows.push(await checkModel(name, param, twin, options, run));
        break;
      case "scalar":
        rows.push(await checkScalar(name, param, run));
        break;
      case "tools":
        rows.push(await checkTools(name, param, sentinel, run));
        rows.push(...checkToolModes(name, param, toolModes, records));
        break;
    }
  }
  rows.push(checkConfigHash(twin, baseline, records));
  return {
    twinId: twin.id,
    rows,
    ok: rows.every((row) => row.status !== "not_wired"),
    runs: records.length,
  };
}

interface RunRecord {
  readonly label: string;
  readonly overrides: readonly string[];
  readonly spans: readonly ReadableSpan[];
  readonly configHash?: string;
  readonly error?: string;
}

type Run = (label: string, overrides: Record<string, unknown>) => Promise<RunRecord>;

/** One run under its own `invoke_agent <id>` root span, with the spans it made. */
async function runOnce(
  twin: Twin,
  options: VerifyOptions,
  overrides: Record<string, unknown>,
  toolModes: Readonly<Record<string, ToolMode>>,
): Promise<RunRecord> {
  const label = Object.keys(overrides).join(", ");
  const attributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": twin.id,
    [RATEL_TWIN_ID]: twin.id,
  };
  const tracer = trace.getTracer("@ratel-ai/twin/verify");
  const done = await tracer.startActiveSpan(
    `invoke_agent ${twin.id}`,
    { attributes },
    async (root) => {
      if (!root.isRecording()) {
        root.end();
        throw new Error(
          "verify needs a recording tracer provider: register one with an in-memory span processor before the twin runs",
        );
      }
      const traceId = root.spanContext().traceId;
      try {
        const result = await runTwin(twin, {
          input: options.input,
          overrides,
          toolModes,
          ...(options.resolveContext ? { resolveContext: options.resolveContext } : {}),
          ...(options.toolChannel ? { toolChannel: options.toolChannel } : {}),
        });
        root.setAttribute(RATEL_TWIN_CONFIG_HASH, result.configHash);
        return { traceId, configHash: result.configHash, overrides: result.overrides };
      } catch (err) {
        root.setStatus({ code: SpanStatusCode.ERROR });
        return { traceId, error: err instanceof Error ? err.message : String(err) };
      } finally {
        root.end();
      }
    },
  );
  return {
    label,
    overrides: done.overrides ?? Object.keys(overrides),
    spans: options.spans.spansOf(done.traceId),
    ...(done.configHash ? { configHash: done.configHash } : {}),
    ...(done.error ? { error: done.error } : {}),
  };
}

async function checkPrompt(
  name: string,
  template: string,
  token: string,
  run: Run,
): Promise<VerifyRow> {
  const record = await run(name, { [name]: `${template}\n\n${token}` });
  const row = (status: VerifyStatus, detail: string) => ({
    param: name,
    kind: "prompt",
    status,
    detail,
  });
  const problem = runProblem(record);
  if (problem) return row("not_wired", problem);
  const seen = modelSpans(record.spans).find((span) => textOf(span).includes(token));
  return seen
    ? row("wired", `sentinel seen in span "${seen.name}"`)
    : row(
        "not_wired",
        `the sentinel did not reach a model call: the code ignores ${name}, or the model call does not record its input`,
      );
}

async function checkModel(
  name: string,
  param: ModelParam,
  twin: Twin,
  options: VerifyOptions,
  run: Run,
): Promise<VerifyRow> {
  const row = (status: VerifyStatus, detail: string) => ({
    param: name,
    kind: "model",
    status,
    detail,
  });
  const choice = secondModel(param, twin, options);
  if ("skip" in choice) return row("skipped", choice.skip);
  const record = await run(name, { [name]: choice.model });
  const problem = runProblem(record);
  if (problem) return row("not_wired", problem);
  const expected = [choice.model, bareModelId(choice.model)];
  const seen = [
    ...new Set(
      modelSpans(record.spans).map((span) => String(span.attributes[GEN_AI_REQUEST_MODEL])),
    ),
  ];
  return seen.some((model) => expected.includes(model))
    ? row("wired", `${GEN_AI_REQUEST_MODEL} = ${choice.model}`)
    : row(
        "not_wired",
        `${GEN_AI_REQUEST_MODEL} was ${seen.join(", ")}, expected ${choice.model}: the code ignores ${name}`,
      );
}

async function checkScalar(name: string, param: ScalarParam, run: Run): Promise<VerifyRow> {
  const row = (status: VerifyStatus, detail: string) => ({
    param: name,
    kind: param.type,
    status,
    detail,
  });
  const attribute = REQUEST_ATTRIBUTES[name.toLowerCase().replace(/[^a-z]/g, "")];
  const value = param.type === "int" || param.type === "number" ? changedNumber(param) : undefined;
  if (!attribute || value === undefined)
    return row("skipped", "cannot verify automatically: no model request attribute records it");
  const record = await run(name, { [name]: value });
  const problem = runProblem(record);
  if (problem) return row("not_wired", problem);
  const seen = modelSpans(record.spans).map((span) => span.attributes[attribute]);
  return seen.includes(value)
    ? row("wired", `${attribute} = ${value}`)
    : row(
        "not_wired",
        `${attribute} was ${seen.map(String).join(", ") || "(not set)"}, expected ${value}: the code ignores ${name}`,
      );
}

/**
 * One run gives each tool a description sentinel and disables the last tool.
 * A toolset of one tool gets a second run to disable it.
 */
async function checkTools(
  name: string,
  param: ToolsParam,
  sentinel: (check: string) => string,
  run: Run,
): Promise<VerifyRow> {
  const row = (status: VerifyStatus, detail: string) => ({
    param: name,
    kind: "tools",
    status,
    detail,
  });
  const tools = param.default;
  const disabled = tools.length >= 2 ? tools[tools.length - 1] : undefined;
  const tokens = new Map(
    tools.filter((t) => t !== disabled).map((t) => [t.name, sentinel(`${name}.${t.name}`)]),
  );
  const edits: ToolEdit[] = tools.map((t) =>
    t === disabled
      ? { name: t.name, enabled: false }
      : { name: t.name, description: `${t.description} ${tokens.get(t.name)}` },
  );
  const record = await run(`${name} (descriptions${disabled ? `, ${disabled.name} off` : ""})`, {
    [name]: edits,
  });
  const problem = runProblem(record);
  if (problem) return row("not_wired", problem);
  const text = modelSpans(record.spans).map(textOf).join("\n");
  const issues = [...tokens]
    .filter(([, token]) => !text.includes(token))
    .map(([tool]) => `the description of ${tool} did not reach the tool definitions`);

  let off = disabled;
  let offRecord = record;
  if (!off && tools[0]) {
    off = tools[0];
    offRecord = await run(`${name} (${off.name} off)`, {
      [name]: [{ name: off.name, enabled: false }],
    });
    const offProblem = runProblem(offRecord);
    if (offProblem) return row("not_wired", offProblem);
  }
  if (off && !toolAbsent(off.name, off.description, offRecord.spans))
    issues.push(`${off.name} was disabled but still reached the model call`);
  if (issues.length > 0) return row("not_wired", issues.join("; "));
  return row(
    "wired",
    `description sentinels seen in the tool definitions${off ? `; ${off.name} off and absent` : ""}`,
  );
}

/** One row per tool: the mode verify asked for must be on its `execute_tool` span. */
function checkToolModes(
  name: string,
  param: ToolsParam,
  modes: Readonly<Record<string, ToolMode>>,
  records: readonly RunRecord[],
): VerifyRow[] {
  const spans = records.flatMap((record) => record.spans);
  return param.default.map((tool) => {
    const mode = modes[tool.name] ?? defaultMode(tool);
    const row = (status: VerifyStatus, detail: string) => ({
      param: `${name}.${tool.name}`,
      kind: `tool (${mode})`,
      status,
      detail,
    });
    const calls = spans.filter((span) => toolNameOf(span) === tool.name);
    const marked = calls.filter((span) => span.attributes[RATEL_TOOL_MODE] !== undefined);
    if (calls.length === 0)
      return row("skipped", `the model did not call ${tool.name}: its mode is not checked`);
    if (marked.length === 0)
      return row(
        "not_wired",
        `${tool.name} ran without ${RATEL_TOOL_MODE}: the code calls the production tool, not params.${name}`,
      );
    const wrong = marked.find((span) => span.attributes[RATEL_TOOL_MODE] !== mode);
    return wrong
      ? row(
          "not_wired",
          `${RATEL_TOOL_MODE} was ${String(wrong.attributes[RATEL_TOOL_MODE])}, expected ${mode}`,
        )
      : row("wired", `${RATEL_TOOL_MODE}=${mode} on execute_tool ${tool.name}`);
  });
}

/** The hash changes with each override, and equals the production hash with none. */
function checkConfigHash(
  twin: Twin,
  baseline: RunRecord,
  records: readonly RunRecord[],
): VerifyRow {
  const row = (status: VerifyStatus, detail: string) => ({
    param: "config hash",
    kind: "hash",
    status,
    detail,
  });
  const base = baseline.configHash ?? "";
  const unchanged = records
    .filter((r) => r !== baseline && r.configHash !== undefined && r.configHash === base)
    .map((r) => r.label);
  if (unchanged.length > 0)
    return row("not_wired", `the hash did not change with: ${unchanged.join(", ")}`);
  if (!twin.defaults)
    return row(
      "skipped",
      "changes with each override; the twin has no `defaults`, so the production hash is not checked",
    );
  const production = localConfigHash(twin.defaults);
  return production === base
    ? row("wired", `changes with each override; no overrides = production (${base.slice(0, 12)})`)
    : row(
        "not_wired",
        `no overrides gives ${base.slice(0, 12)}, production (resolveLocal) gives ${production.slice(0, 12)}: the param names or defaults differ from the defaults object`,
      );
}

/** A tool mode verify can run without a reviewer and without a real side effect. */
function verifyToolModes(params: ParamMap): Record<string, ToolMode> {
  const modes: Record<string, ToolMode> = {};
  for (const param of Object.values(params)) {
    if (param.kind !== "tools") continue;
    for (const tool of param.default) {
      const mode = defaultMode(tool);
      modes[tool.name] = mode === "confirm" ? "fake" : mode;
    }
  }
  return modes;
}

/** The second model of the model check, or why there is none. */
function secondModel(
  param: ModelParam,
  twin: Twin,
  options: VerifyOptions,
): { model: string } | { skip: string } {
  if (options.model) return { model: options.model };
  const candidates = [...(param.options ?? []), ...alternatesOf(param.default)].filter(
    (m) => m !== param.default,
  );
  const languageModel = twin.resolve?.modelKind === "language-model";
  if (options.dry && languageModel) {
    const first = candidates[0];
    return first ? { model: first } : { skip: "no second model: pass --model <provider/model>" };
  }
  if (twin.resolve && !twin.resolve.callableProviders)
    return {
      skip: "the twin's own resolve does not list its callable models: pass --model <provider/model>",
    };
  const env = options.env ?? process.env;
  const providers = (
    twin.resolve?.callableProviders?.(env, options.resolveContext) ?? callableProviders(env)
  ).map((p) => p.provider);
  const callable = (model: string) =>
    (languageModel && providers.includes("gateway")) || providers.includes(providerOf(model));
  const pick = candidates.find(callable);
  return pick
    ? { model: pick }
    : {
        skip: `no second callable model besides ${param.default}: set the key of another model, or pass --model <provider/model>`,
      };
}

/** Built-in alternates of the same provider, named like the default (dots or dashes in the version). */
function alternatesOf(model: string): string[] {
  const dotted = /\d\.\d/.test(model);
  return (ALTERNATE_MODELS[providerOf(model)] ?? []).map((m) =>
    dotted ? m.replace(/(\d)-(\d)$/, "$1.$2") : m,
  );
}

function providerOf(model: string): string {
  return model.slice(0, Math.max(0, model.indexOf("/")));
}

/** A number other than the default, inside min and max. */
function changedNumber(param: ScalarParam): number | undefined {
  if (param.type !== "int" && param.type !== "number") return undefined;
  const step = param.type === "int" ? 1 : 0.1;
  const round = (n: number) => Number(n.toFixed(6));
  const candidates = [
    round(param.default - step),
    round(param.default + step),
    param.min,
    param.max,
  ];
  return candidates.find(
    (n): n is number =>
      n !== undefined &&
      n !== param.default &&
      (param.min === undefined || n >= param.min) &&
      (param.max === undefined || n <= param.max),
  );
}

/** An AI SDK twin with every model replaced by the stand-in. Other twins call their own client. */
function withDryModels(twin: Twin): Twin {
  if (twin.resolve?.modelKind !== "language-model") return twin;
  const resolve = Object.assign((modelId: string) => new DryModel(modelId), {
    modelKind: "language-model" as const,
    callableProviders: () => [{ provider: "dry", keys: [] }],
  });
  return { ...twin, resolve: resolve as ModelResolver<unknown> };
}

function runProblem(record: RunRecord): string | null {
  if (record.error) return `the run failed: ${record.error}`;
  return modelSpans(record.spans).length === 0 ? NO_MODEL_SPAN : null;
}

/** The spans of a model call: they record the requested model. */
function modelSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter((span) => span.attributes[GEN_AI_REQUEST_MODEL] !== undefined);
}

/** The tool a span executes: our `execute_tool` span, or the AI SDK's `ai.toolCall`. */
function toolNameOf(span: ReadableSpan): string | undefined {
  const name = span.attributes["gen_ai.tool.name"] ?? span.attributes["ai.toolCall.name"];
  return typeof name === "string" ? name : undefined;
}

function toolAbsent(tool: string, description: string, spans: readonly ReadableSpan[]): boolean {
  const called = spans.some((span) => toolNameOf(span) === tool);
  const defined =
    description !== "" && modelSpans(spans).some((span) => textOf(span).includes(description));
  return !called && !defined;
}

/** Every string a span records: its attributes and the attributes of its events. */
function textOf(span: ReadableSpan): string {
  const values = [
    ...Object.values(span.attributes),
    ...span.events.flatMap((event) => Object.values(event.attributes ?? {})),
  ];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function randomSentinel(check: string): string {
  return `ratel-verify-${check.replace(/[^A-Za-z0-9]/g, "-")}-${randomBytes(4).toString("hex")}`;
}
