import { estimateCostUsd, estimateTokens } from "../native/index.cjs";

/**
 * Usage-rollup assembly and the metrics-export seam (ADR-0013). Turns one agent
 * interaction into the snake_case *rollup* that Ratel's dashboard ingests at
 * `POST {host}/api/v1/events`. The token / cost maths come from `ratel-ai-core`
 * (native). This module only builds rollups and defines the `Transport` seam a
 * shipper plugs into — the concrete cloud client lives in `@ratel-ai/cloud`.
 */

/** The context sources the dashboard breaks spend and savings down by. */
export const CONTEXT_SOURCES = ["skills", "tools", "history", "memory", "user_input"] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** A full per-source token map (all five keys present). */
export type SourceTokens = Record<ContextSource, number>;

/** A partial per-source map — callers usually set only the sources that apply. */
export type PartialSources = Partial<Record<ContextSource, number>>;

/** A raw context segment to be token-counted for you: a string, an object (a tools
 * array, a message, etc.), or an array of either. */
export type RawSegment = string | object;

/** Raw per-source context. Pass what you already have — the system/skills text, the
 * tools array, the prior messages, the retrieved memory, the user's turn — and the
 * SDK counts the tokens for you via the core estimator. No manual tokenization. */
export interface InteractionContext {
  skills?: RawSegment;
  tools?: RawSegment;
  history?: RawSegment;
  memory?: RawSegment;
  userInput?: RawSegment;
}

/** One interaction's usage, in idiomatic camelCase. */
export interface TrackInput {
  /** Pre-counted per-source spend. Use when you already have exact token counts
   * (provider usage, tiktoken). Otherwise pass `context` and let the SDK count. */
  tokensByCategory?: PartialSources;
  /** Raw context segments — the SDK token-counts each for you. Ignored when
   * `tokensByCategory` is given. */
  context?: InteractionContext;
  /** What Ratel selection kept OUT of the prompt this run. */
  savedByCategory?: PartialSources;
  /** What selection COULD save in observe-only mode. */
  saveableByCategory?: PartialSources;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  latencyMs?: number;
  /** Explicit cost; estimated from `model` + tokens when omitted. */
  costUsd?: number;
  occurredAt?: Date | string;
}

/** The on-the-wire rollup — snake_case keys exactly as the cloud accepts them. */
export type Rollup = Record<string, unknown>;

function zeroSources(): SourceTokens {
  return { skills: 0, tools: 0, history: 0, memory: 0, user_input: 0 };
}

function normalizeSources(value: PartialSources | undefined): SourceTokens | undefined {
  if (value == null) return undefined;
  const out = zeroSources();
  for (const key of CONTEXT_SOURCES) {
    const raw = value[key];
    out[key] = raw && raw > 0 ? Math.trunc(raw) : 0;
  }
  return out;
}

function total(sources: SourceTokens): number {
  let sum = 0;
  for (const key of CONTEXT_SOURCES) sum += sources[key];
  return sum;
}

/** Token-count a raw segment via the core estimator: a string directly, an array
 * element-wise, any other object by its compact JSON. */
function countSegment(seg: RawSegment | undefined): number {
  if (seg == null) return 0;
  if (typeof seg === "string") return estimateTokens(seg);
  if (Array.isArray(seg)) return seg.reduce((sum: number, item) => sum + countSegment(item), 0);
  return estimateTokens(JSON.stringify(seg));
}

/** Derive per-source token counts from raw context segments. */
function tokensFromContext(ctx: InteractionContext): PartialSources {
  return {
    skills: countSegment(ctx.skills),
    tools: countSegment(ctx.tools),
    history: countSegment(ctx.history),
    memory: countSegment(ctx.memory),
    user_input: countSegment(ctx.userInput),
  };
}

/**
 * Assemble one interaction's rollup event. The only required field is
 * `tokensByCategory`; `inputTokens` defaults to the per-source sum, and `costUsd`
 * is estimated in-core from model + tokens unless supplied.
 */
export function buildRollup(input: TrackInput): Rollup {
  const perSource =
    input.tokensByCategory ?? (input.context ? tokensFromContext(input.context) : undefined);
  const tokens = normalizeSources(perSource) ?? zeroSources();
  const event: Rollup = { tokens_by_category: tokens };

  const saved = normalizeSources(input.savedByCategory);
  if (saved) event.saved_by_category = saved;
  const saveable = normalizeSources(input.saveableByCategory);
  if (saveable) event.saveable_by_category = saveable;

  const inputTokens = input.inputTokens ?? total(tokens);
  event.input_tokens = inputTokens;
  if (input.outputTokens != null) event.output_tokens = input.outputTokens;
  if (input.model) event.model = input.model;
  if (input.latencyMs != null) event.latency_ms = input.latencyMs;

  if (input.costUsd != null) {
    event.cost_usd = input.costUsd;
  } else if (input.model) {
    const out = input.outputTokens ?? 0;
    event.cost_usd = Math.round(estimateCostUsd(input.model, inputTokens, out) * 1e6) / 1e6;
  }

  if (input.occurredAt != null) {
    event.occurred_at =
      input.occurredAt instanceof Date ? input.occurredAt.toISOString() : String(input.occurredAt);
  }
  return event;
}

/** Sends a batch of rollups somewhere; implemented by `@ratel-ai/cloud` or a custom transport. */
export type Transport = (batch: ReadonlyArray<Rollup>) => Promise<void> | void;
