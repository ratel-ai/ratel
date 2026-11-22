/**
 * The sandbox playground's pure state (spec §9): the param diff against the code
 * defaults, the config pill, the run view folded from the run's SSE events,
 * and the small readers the form and the params panel draw from. No I/O and no
 * React, so the browser and the tests share one set of rules.
 */

import {
  type ManifestTool,
  type ToolMode,
  type ToolSetting,
  toolModesFor,
  toolsParamOverrides,
} from "./tools-state";

/** A manifest param as the playground reads it (`@ratel-ai/sandbox` ManifestParam, plain JSON). */
export type PlaygroundParam = { name: string; description?: string } & (
  | { kind: "model"; default: string; options?: readonly string[] }
  | { kind: "prompt"; default: string; vars?: readonly string[] }
  | { kind: "scalar"; type: "int" | "number"; default: number; min?: number; max?: number }
  | { kind: "scalar"; type: "bool"; default: boolean }
  | { kind: "scalar"; type: "enum"; default: string; values: readonly string[] }
  | { kind: "scalar"; type: "string"; default: string; maxLength?: number }
  | { kind: "tools"; default?: unknown }
);

export interface ParamChange {
  name: string;
  kind: PlaygroundParam["kind"];
  from: unknown;
  to: unknown;
}

export interface CallableProvider {
  provider: string;
  keys: readonly string[];
}

export interface TemplateSegment {
  text: string;
  variable: boolean;
}

export type RunPhase = "idle" | "starting" | "live" | "ended";

export interface ToolCallView {
  callId: string;
  tool: string;
  args: unknown;
  mode: string | null;
  result?: unknown;
  isError?: boolean;
  /** pinned, recorded or generated: where a fake value came from. */
  fakeSource?: string | null;
  /** approve, edit, fake or reject: the reviewer's decision on a confirm call. */
  confirmDecision?: string | null;
  done: boolean;
}

export interface RunViewState {
  phase: RunPhase;
  runId: string | null;
  sessionId: string | null;
  configHash: string | null;
  overrides: string[];
  /** The server status: queued, running, ok, error, canceled, rejected, lost. */
  status: string | null;
  text: string;
  logs: { level: string; message: string }[];
  tools: ToolCallView[];
  output: unknown;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  traceId: string | null;
  error: string | null;
  lastSeq: number;
  startedAt: number | null;
  latencyMs: number | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** One chat turn: the user's message and the run that answered it (one run per turn). */
export interface ChatTurn {
  user: string;
  /** Null when the run API refused the turn before a run started. */
  runId: string | null;
  traceId: string | null;
  status: string | null;
  /** The reply text, or null when the run gave none. */
  assistant: string | null;
  /** Set on a turn that did not end ok: the server message, or a generic one. */
  error: string | null;
  tools: ToolCallView[];
}

/** A run as the runs list returns it, with only the fields a chat turn reads. */
export interface ChatRunRow {
  id: string;
  sessionId: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  traceId: string | null;
  createdAt: string;
}

/** The body of `POST /sandboxes/runs`. */
export interface RunRequestBody {
  runnerId: string;
  sandboxId: string;
  sessionId?: string;
  input: unknown;
  params: Record<string, unknown>;
  toolModes: Record<string, ToolMode>;
  context: Record<string, unknown>;
  replay?: { sourceTraceId: string; arm: string };
}

export type RunViewAction =
  | { type: "starting" }
  | { type: "refused"; message: string }
  | {
      type: "started";
      runId: string;
      sessionId: string;
      configHash: string;
      overrides: string[];
      at: number;
    }
  | { type: "event"; seq: number; kind: string; payload: Record<string, unknown>; at?: number }
  | { type: "status"; status: string; error: unknown; at: number };

export const BASELINE_PILL = "baseline = production config";
/** Characters of unchanged text kept before the first change in the diff. */
const DIFF_CONTEXT_CHARS = 24;

export const initialRunView: RunViewState = {
  phase: "idle",
  runId: null,
  sessionId: null,
  configHash: null,
  overrides: [],
  status: null,
  text: "",
  logs: [],
  tools: [],
  output: null,
  usage: null,
  traceId: null,
  error: null,
  lastSeq: 0,
  startedAt: null,
  latencyMs: null,
};

const TEMPLATE_VAR = /\{\{\s*[\w.-]+\s*\}\}|\$\{\s*[\w.-]+\s*\}/g;
const ENDED_STATUSES = new Set(["ok", "error", "canceled", "rejected", "lost", "unknown"]);

/** The names of the params whose edited value differs from the code default, in manifest order. */
export function changedParams(
  params: readonly PlaygroundParam[],
  values: Readonly<Record<string, unknown>>,
): string[] {
  return params.filter((p) => isChanged(p, values)).map((p) => p.name);
}

/** The `params` of a run request: only the changed values. */
export function paramOverrides(
  params: readonly PlaygroundParam[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    params.filter((p) => isChanged(p, values)).map((p) => [p.name, values[p.name]]),
  );
}

/** Each changed param with its code default and its edited value. */
export function paramDiff(
  params: readonly PlaygroundParam[],
  values: Readonly<Record<string, unknown>>,
): ParamChange[] {
  return params
    .filter((p) => isChanged(p, values))
    .map((p) => ({ name: p.name, kind: p.kind, from: p.default, to: values[p.name] }));
}

/**
 * The part of a changed value worth showing: a long text starts shortly before
 * its first changed character, so an edit at the end of a prompt is visible.
 * Other values show as JSON.
 */
export function diffWindow(from: unknown, to: unknown): { from: string; to: string } {
  const a = typeof from === "string" ? from : JSON.stringify(from);
  const b = typeof to === "string" ? to : JSON.stringify(to);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  const start = Math.max(0, common - DIFF_CONTEXT_CHARS);
  if (start === 0) return { from: a, to: b };
  return { from: `…${a.slice(start)}`, to: `…${b.slice(start)}` };
}

/**
 * The config pill: "baseline = production config" when nothing is edited and
 * the config hash is the one production runs with, else the changed names.
 */
export function configPillText(input: {
  changed: readonly string[];
  configHash: string | null;
  productionHash: string | null;
}): string {
  const { changed, configHash, productionHash } = input;
  if (changed.length > 0) return `${changed.length} changed: ${changed.join(", ")}`;
  if (configHash && productionHash && configHash === productionHash) return BASELINE_PILL;
  if (configHash && productionHash) return "code defaults, not production config";
  return "code defaults";
}

/**
 * The models a model param offers: the code default first, then its options.
 * With the built-in resolver an option needs a callable provider (its
 * `provider/` prefix); a custom resolver names its own engines, so all stay.
 */
export function modelOptions(
  param: PlaygroundParam,
  providers: readonly CallableProvider[],
  resolver: "builtin" | "custom",
): string[] {
  if (param.kind !== "model") return [];
  const callable = new Set(providers.map((p) => p.provider));
  const options = (param.options ?? []).filter(
    (id) => resolver === "custom" || callable.has(providerOf(id)),
  );
  return [...new Set([param.default, ...options])];
}

/** A prompt template cut into text and `{{var}}` / `${var}` pieces, for highlighting. */
export function templateSegments(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let last = 0;
  for (const match of template.matchAll(TEMPLATE_VAR)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: template.slice(last, start), variable: false });
    segments.push({ text: match[0], variable: true });
    last = start + match[0].length;
  }
  if (last < template.length || segments.length === 0)
    segments.push({ text: template.slice(last), variable: false });
  return segments;
}

/**
 * A starting value for a structured input: empty strings and lists, zeros, the
 * first enum value. A structured input is one JSON object, so a schema that
 * says nothing starts as `{}`.
 */
export function inputSkeleton(schema: Readonly<Record<string, unknown>>): unknown {
  return skeletonOf(schema) ?? {};
}

/** The message per param of a 400 `invalid_params` answer; empty for any other answer. */
export function paramErrors(body: unknown): Record<string, string> {
  const params = (body as { error?: unknown; params?: unknown } | null)?.params;
  if (!Array.isArray(params)) return {};
  return Object.fromEntries(
    params
      .filter(
        (p): p is { param: string; message: string } =>
          typeof p?.param === "string" && typeof p?.message === "string",
      )
      .map((p) => [p.param, p.message]),
  );
}

/** Runs grouped by session, in the order each session first appears (newest first in, newest first out). */
export function groupBySession<R extends { sessionId: string | null }>(
  runs: readonly R[],
): { sessionId: string | null; runs: R[] }[] {
  const groups = new Map<string | null, R[]>();
  for (const run of runs) {
    const group = groups.get(run.sessionId);
    if (group) group.push(run);
    else groups.set(run.sessionId, [run]);
  }
  return [...groups].map(([sessionId, grouped]) => ({ sessionId, runs: grouped }));
}

/**
 * The run request of the playground: only the changed params, with the edits
 * of the Tools panel merged in as tools params, and the tool modes that differ
 * from their defaults. Edits apply to the run they are sent with.
 */
export function runRequestBody(input: {
  runnerId: string;
  sandboxId: string;
  sessionId: string | null;
  input: unknown;
  params: readonly PlaygroundParam[];
  values: Readonly<Record<string, unknown>>;
  tools: readonly ManifestTool[];
  toolSettings: Readonly<Record<string, ToolSetting>>;
  replay?: { sourceTraceId: string; arm: string };
}): RunRequestBody {
  return {
    runnerId: input.runnerId,
    sandboxId: input.sandboxId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    input: input.input,
    params: {
      ...paramOverrides(input.params, input.values),
      ...toolsParamOverrides(input.tools, input.toolSettings),
    },
    toolModes: toolModesFor(input.tools, input.toolSettings),
    context: {},
    ...(input.replay ? { replay: input.replay } : {}),
  };
}

/**
 * The reply of a chat run: the streamed text, else the output when it is a
 * string, else the output's `text` field. Null when the run gave no text.
 */
export function assistantText(text: string, output: unknown): string | null {
  if (text) return text;
  if (typeof output === "string") return output || null;
  const field = (output as { text?: unknown } | null)?.text;
  return typeof field === "string" && field ? field : null;
}

/** An ended (or refused) run frozen as the chat turn of the user's message. */
export function chatTurn(user: string, view: RunViewState): ChatTurn {
  const ok = view.status === "ok";
  return {
    user,
    runId: view.runId,
    traceId: view.traceId,
    status: view.status,
    assistant: assistantText(view.text, view.output),
    error: ok ? null : turnError(view.status, view.error),
    tools: view.tools,
  };
}

/**
 * The `messages` of the next chat run: every turn that ended ok (its user
 * message, then its reply when it has one), then the new message. A failed
 * turn has no reply to build on, so it stays out.
 */
export function chatMessages(turns: readonly ChatTurn[], next: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.status !== "ok") continue;
    messages.push({ role: "user", content: turn.user });
    if (turn.assistant) messages.push({ role: "assistant", content: turn.assistant });
  }
  messages.push({ role: "user", content: next });
  return messages;
}

/**
 * One session's turns rebuilt from the runs list (newest first), oldest first.
 * Each run is one turn: its last user message and its reply. The list carries
 * no tool calls, so a rebuilt turn has none.
 */
export function chatTurnsFromRuns(runs: readonly ChatRunRow[], sessionId: string): ChatTurn[] {
  return runs
    .filter((run) => run.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => ({
      user: lastUserMessage(run.input),
      runId: run.id,
      traceId: run.traceId,
      status: run.status,
      assistant: run.status === "ok" ? assistantText("", run.output) : null,
      error: run.status === "ok" ? null : turnError(run.status, errorMessage(run.error)),
      tools: [],
    }));
}

/**
 * Folds one action into the run view. Events are folded once per seq, so an
 * EventSource that reconnects and replays a seq changes nothing.
 */
export function reduceRunView(state: RunViewState, action: RunViewAction): RunViewState {
  switch (action.type) {
    case "starting":
      return { ...initialRunView, phase: "starting" };
    case "refused":
      return { ...initialRunView, error: action.message };
    case "started":
      return {
        ...initialRunView,
        phase: "live",
        runId: action.runId,
        sessionId: action.sessionId,
        configHash: action.configHash,
        overrides: action.overrides,
        status: "queued",
        startedAt: action.at,
      };
    case "event":
      if (action.seq <= state.lastSeq) return state;
      return { ...applyEvent(state, action.kind, action.payload, action.at), lastSeq: action.seq };
    case "status":
      return {
        ...state,
        phase: ENDED_STATUSES.has(action.status) ? "ended" : state.phase,
        status: action.status,
        error: state.error ?? errorMessage(action.error),
        latencyMs: state.latencyMs ?? latency(state, action.at),
      };
  }
}

function applyEvent(
  state: RunViewState,
  kind: string,
  payload: Record<string, unknown>,
  at: number | undefined,
): RunViewState {
  switch (kind) {
    case "text.delta":
      return typeof payload.text === "string"
        ? { ...state, status: "running", text: state.text + payload.text }
        : state;
    case "log":
      return {
        ...state,
        status: "running",
        logs: [
          ...state.logs,
          {
            level: typeof payload.level === "string" ? payload.level : "info",
            message: String(payload.message ?? ""),
          },
        ],
      };
    case "tool.call":
      return {
        ...state,
        status: "running",
        tools: [
          ...state.tools,
          {
            callId: String(payload.callId ?? ""),
            tool: String(payload.tool ?? ""),
            args: payload.args ?? null,
            mode: stringOrNull(payload.mode),
            done: false,
          },
        ],
      };
    case "tool.result":
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.callId === payload.callId
            ? {
                ...t,
                result: payload.result ?? null,
                isError: payload.isError === true,
                mode: stringOrNull(payload.mode) ?? t.mode,
                fakeSource: stringOrNull(payload.fakeSource),
                confirmDecision: stringOrNull(payload.confirmDecision),
                done: true,
              }
            : t,
        ),
      };
    case "run.end": {
      const status =
        payload.status === "ok" || payload.status === "canceled" ? payload.status : "error";
      return {
        ...state,
        phase: "ended",
        status,
        output: payload.output ?? null,
        usage: (payload.usage as RunViewState["usage"]) ?? null,
        traceId: stringOrNull(payload.traceId),
        overrides: Array.isArray(payload.overrides)
          ? payload.overrides.filter((o): o is string => typeof o === "string")
          : state.overrides,
        error: status === "error" ? (errorMessage(payload.error) ?? "The run failed.") : null,
        latencyMs: at === undefined ? state.latencyMs : latency(state, at),
      };
    }
    default:
      return state;
  }
}

function turnError(status: string | null, error: string | null): string {
  if (status === "canceled") return "You canceled this turn.";
  return error ?? "The run failed.";
}

function lastUserMessage(input: unknown): string {
  const messages = (input as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  const last = [...messages].reverse().find((m) => (m as ChatMessage | null)?.role === "user") as
    | ChatMessage
    | undefined;
  return typeof last?.content === "string" ? last.content : "";
}

function skeletonOf(schema: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (type === "object" || properties) {
    return Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, child]) => [key, skeletonOf(child)]),
    );
  }
  if (type === "array") return [];
  if (type === "string") return "";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return null;
}

function isChanged(param: PlaygroundParam, values: Readonly<Record<string, unknown>>): boolean {
  if (!(param.name in values)) return false;
  return !sameValue(values[param.name], param.default);
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash < 0 ? "" : modelId.slice(0, slash);
}

function latency(state: RunViewState, at: number): number | null {
  return state.startedAt === null ? null : Math.max(0, at - state.startedAt);
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
