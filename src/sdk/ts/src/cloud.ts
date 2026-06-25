import { estimateCostUsd } from "../native/index.cjs";

/** Read an environment variable without a hard dependency on Node's `process` types. */
function envVar(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

/**
 * Lean cloud analytics client — the TypeScript mirror of the Python SDK's
 * `RatelClient` (ADR-0016). Records one usage *rollup* per agent interaction and
 * ships it to `POST {host}/api/v1/events` — the exact shape Ratel's dashboard
 * renders. Best-effort and batched; never throws into caller code, and absent an
 * API key it is a no-op. Token/cost maths come from `ratel-ai-core` (native).
 */

/** The context sources the dashboard breaks spend and savings down by. */
export const CONTEXT_SOURCES = ["skills", "tools", "history", "memory", "user_input"] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** A full per-source token map (all five keys present). */
export type SourceTokens = Record<ContextSource, number>;

/** A partial per-source map — callers usually set only the sources that apply. */
export type PartialSources = Partial<Record<ContextSource, number>>;

/** One interaction's usage, in idiomatic camelCase. */
export interface TrackInput {
  /** Per-source prompt spend this interaction. */
  tokensByCategory: PartialSources;
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

/**
 * Assemble one interaction's rollup event. The only required field is
 * `tokensByCategory`; `inputTokens` defaults to the per-source sum, and `costUsd`
 * is estimated in-core from model + tokens unless supplied.
 */
export function buildRollup(input: TrackInput): Rollup {
  const tokens = normalizeSources(input.tokensByCategory) ?? zeroSources();
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

/** Sends a batch of rollups somewhere; overridable in tests. */
export type Transport = (batch: ReadonlyArray<Rollup>) => Promise<void> | void;

export interface RatelClientOptions {
  apiKey?: string;
  host?: string;
  enabled?: boolean;
  /** Flush automatically once this many rollups are buffered (default 50). */
  flushAt?: number;
  /** Per-request timeout for the default fetch transport (default 5000ms). */
  timeoutMs?: number;
  /** Override the network transport — primarily for tests. */
  transport?: Transport;
}

export class RatelClient {
  private readonly apiKey: string | undefined;
  private readonly eventsUrl: string;
  private readonly enabled: boolean;
  private readonly flushAt: number;
  private readonly timeoutMs: number;
  private readonly transport: Transport | undefined;
  private buffer: Rollup[] = [];

  constructor(options: RatelClientOptions = {}) {
    this.apiKey = options.apiKey ?? envVar("RATEL_API_KEY");
    const host = (options.host ?? envVar("RATEL_HOST") ?? "https://cloud.ratel.sh").replace(
      /\/+$/,
      "",
    );
    this.eventsUrl = `${host}/api/v1/events`;
    this.enabled = options.enabled ?? Boolean(this.apiKey);
    this.flushAt = options.flushAt ?? 50;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.transport = options.transport;
  }

  /** True when the client should ship: a transport is set, or it's enabled with a key. */
  get canExport(): boolean {
    return this.transport != null || (this.enabled && Boolean(this.apiKey));
  }

  /** Record one interaction's usage rollup. Best-effort; never throws. */
  track(input: TrackInput): void {
    if (!this.canExport) return;
    try {
      this.buffer.push(buildRollup(input));
      if (this.buffer.length >= this.flushAt) void this.flush();
    } catch {
      // assembling/buffering must never break the caller
    }
  }

  /** Send everything buffered. Resolves once the send settles (or is swallowed). */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.send(batch);
    } catch {
      // best-effort: a failed send is dropped, never surfaced
    }
  }

  private async send(batch: ReadonlyArray<Rollup>): Promise<void> {
    if (this.transport) {
      await this.transport(batch);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fetch(this.eventsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
