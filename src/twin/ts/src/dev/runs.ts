import type { Manifest, ManifestTwin } from "../manifest.js";
import { checkParamValue } from "../params.js";
import { checkInput } from "../twin.js";
import { jsonBytes, splitText, truncateText, truncateValue } from "./frame-size.js";
import { type Envelope, type FrameStamp, frame, MAX_FRAME_BYTES } from "./protocol.js";

// The run half of the twin/v1 worker as a pure state machine. It turns
// run.start into one execution, numbers the run's events by seq, keeps every
// event until the controller acks it, and answers cancel and lease. No I/O, no
// clock: the runtime passes the time in and performs the effects.

export interface RunStartPayload {
  readonly twinId: string;
  readonly sessionId?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly toolModes?: Readonly<Record<string, string>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly configHash: string;
  readonly replay?: {
    readonly sourceTraceId?: string;
    readonly sourceSessionId?: string;
    readonly arm?: "baseline" | "candidate";
  };
}

/** One `run.event` payload, as the child worker reports it. */
export type RunEventPayload = { readonly kind: string } & Readonly<Record<string, unknown>>;

export interface RunResult {
  readonly status: "ok" | "error" | "canceled";
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly traceId?: string;
  readonly overrides?: readonly string[];
}

export type RejectReason = "busy" | "unknown_twin" | "invalid_params";

export type RunsEffect =
  /** Send on the live socket, if there is one. Event frames stay buffered until acked. */
  | { readonly type: "send"; readonly frame: Envelope }
  | {
      readonly type: "execute";
      readonly runId: string;
      readonly start: RunStartPayload;
    }
  | { readonly type: "abort"; readonly runId: string; readonly reason: string };

export interface RunsOptions {
  readonly stamp: FrameStamp;
  readonly maxConcurrency: number;
  readonly maxFrameBytes?: number;
  /** How many finished run IDs to remember for idempotency. */
  readonly rememberFinished?: number;
}

interface LiveRun {
  readonly runId: string;
  readonly startedAt: number;
  nextSeq: number;
  acked: number;
  ended: boolean;
  /** Sent frames (run.event, run.end) above `acked`, in seq order. */
  readonly unacked: Envelope[];
}

export class Runs {
  readonly #runs = new Map<string, LiveRun>();
  readonly #finished: string[] = [];
  readonly #options: RunsOptions;

  constructor(options: RunsOptions) {
    this.#options = options;
  }

  /** Runs that have not ended. */
  get active(): number {
    let n = 0;
    for (const run of this.#runs.values()) if (!run.ended) n++;
    return n;
  }

  /** run.start from the controller. Idempotent by runId: a repeat re-acks and never runs again. */
  start(incoming: Envelope, manifest: Manifest, now: Date): RunsEffect[] {
    const runId = incoming.runId;
    if (!runId) return [];
    if (this.#runs.has(runId) || this.#finished.includes(runId)) return [this.#ack(runId)];
    const start = incoming.payload as RunStartPayload;
    const problem = this.#check(start, manifest);
    if (problem) return [this.#reject(runId, problem)];
    this.#runs.set(runId, {
      runId,
      startedAt: now.getTime(),
      nextSeq: 1,
      acked: 0,
      ended: false,
      unacked: [],
    });
    return [this.#ack(runId), { type: "execute", runId, start }];
  }

  /** One event from the run. Text too long for a frame is split, other values are cut. */
  event(runId: string, payload: RunEventPayload): RunsEffect[] {
    const run = this.#runs.get(runId);
    if (!run || run.ended) return [];
    return this.#fit(payload).map((part) => this.#buffer(run, "run.event", part));
  }

  /** The run finished. Its run.end takes the next seq and stays buffered until acked. */
  end(runId: string, result: RunResult): RunsEffect[] {
    const run = this.#runs.get(runId);
    if (!run || run.ended) return [];
    run.ended = true;
    const effect = this.#buffer(run, "run.end", this.#fitEnd(result));
    this.#forgetIfDone(run);
    return [effect];
  }

  /** run.cancel: abort the run. Its run.end comes from the runtime with status canceled. */
  cancel(runId: string, reason = "canceled by the controller"): RunsEffect[] {
    const run = this.#runs.get(runId);
    if (!run || run.ended) return [];
    return [{ type: "abort", runId, reason }];
  }

  /** events.ack: the controller stored every frame up to seq. */
  ack(runId: string, seq: number): void {
    const run = this.#runs.get(runId);
    if (!run || seq <= run.acked) return;
    run.acked = seq;
    while (run.unacked.length > 0 && (run.unacked[0]?.seq ?? 0) <= seq) run.unacked.shift();
    this.#forgetIfDone(run);
  }

  /** One run.lease per live run. */
  lease(now: Date): RunsEffect[] {
    const effects: RunsEffect[] = [];
    for (const run of this.#runs.values()) {
      if (run.ended) continue;
      const elapsedMs = Math.max(0, now.getTime() - run.startedAt);
      effects.push({
        type: "send",
        frame: frame(this.#options.stamp, "run.lease", { elapsedMs }, { runId: run.runId }),
      });
    }
    return effects;
  }

  /** Every event and end frame the controller has not acked, per run in seq order. For a new socket. */
  unacked(): Envelope[] {
    return [...this.#runs.values()].flatMap((run) => run.unacked);
  }

  #check(
    start: RunStartPayload,
    manifest: Manifest,
  ):
    | { reason: RejectReason; message: string; errors?: { param: string; message: string }[] }
    | undefined {
    const twin = manifest.twins.find((t) => t.id === start.twinId);
    if (!twin) {
      const known = manifest.twins.map((t) => t.id).join(", ") || "(none)";
      return { reason: "unknown_twin", message: `unknown twin "${start.twinId}". Known: ${known}` };
    }
    const errors: { param: string; message: string }[] = [];
    const params = start.params ?? {};
    // An AI SDK twin calls the model itself: its provider must be callable here.
    const uncallable = (param: ManifestTwin["params"][number], value: unknown) =>
      param.kind === "model" &&
      twin.modelKind === "language-model" &&
      twin.modelResolver === "builtin"
        ? uncallableModel(String(value), manifest)
        : null;
    for (const name of Object.keys(params)) {
      const param = twin.params.find((p) => p.name === name);
      if (!param) {
        errors.push({ param: name, message: "is an unknown param" });
        continue;
      }
      const problem = checkParamValue(param, params[name]) ?? uncallable(param, params[name]);
      if (problem) errors.push({ param: name, message: problem });
    }
    for (const param of twin.params) {
      if (Object.hasOwn(params, param.name)) continue;
      const problem = uncallable(param, param.default);
      if (problem) errors.push({ param: param.name, message: problem });
    }
    const inputProblem = twin.input.kind === "chat" ? checkInput(twin.input, start.input) : null;
    if (inputProblem) errors.push({ param: "input", message: inputProblem });
    if (errors.length > 0) {
      const detail = errors.map((e) => `${e.param} ${e.message}`).join("; ");
      return { reason: "invalid_params", message: `${twin.id}: ${detail}`, errors };
    }
    if (this.active >= this.#options.maxConcurrency) {
      return {
        reason: "busy",
        message: `the runner is at its limit of ${this.#options.maxConcurrency} run(s)`,
      };
    }
    return undefined;
  }

  #ack(runId: string): RunsEffect {
    return { type: "send", frame: frame(this.#options.stamp, "run.ack", {}, { runId }) };
  }

  #reject(
    runId: string,
    problem: {
      reason: RejectReason;
      message: string;
      errors?: { param: string; message: string }[];
    },
  ): RunsEffect {
    return { type: "send", frame: frame(this.#options.stamp, "run.reject", problem, { runId }) };
  }

  #buffer(run: LiveRun, type: "run.event" | "run.end", payload: object): RunsEffect {
    const out = frame(this.#options.stamp, type, payload, { runId: run.runId, seq: run.nextSeq++ });
    run.unacked.push(out);
    return { type: "send", frame: out };
  }

  /** The room for a payload inside one frame: the limit minus a generous envelope. */
  get #payloadBudget(): number {
    return (this.#options.maxFrameBytes ?? MAX_FRAME_BYTES) - ENVELOPE_ALLOWANCE;
  }

  #fit(payload: RunEventPayload): RunEventPayload[] {
    const budget = this.#payloadBudget;
    if (jsonBytes(payload) <= budget) return [payload];
    if (payload.kind === "text.delta" && typeof payload.text === "string") {
      const room = budget - jsonBytes({ ...payload, text: "" }) + 2;
      return splitText(payload.text, room).map((text) => ({ ...payload, text }));
    }
    return [shrink(payload, budget)];
  }

  #fitEnd(result: RunResult): RunResult {
    const budget = this.#payloadBudget;
    if (jsonBytes(result) <= budget) return result;
    return shrink({ ...result }, budget);
  }

  #forgetIfDone(run: LiveRun): void {
    if (!run.ended || run.unacked.length > 0) return;
    this.#runs.delete(run.runId);
    this.#finished.push(run.runId);
    const keep = this.#options.rememberFinished ?? 1000;
    if (this.#finished.length > keep) this.#finished.splice(0, this.#finished.length - keep);
  }
}

/**
 * Why an AI SDK model value cannot run on this worker, or null. The gateway
 * reaches every provider; otherwise the model's own provider must be listed.
 */
function uncallableModel(modelId: string, manifest: Manifest): string | null {
  const names = manifest.providers.map((p) => p.provider);
  const provider = modelId.slice(0, modelId.indexOf("/"));
  if (names.includes("gateway") || names.includes(provider)) return null;
  const listed = names.length > 0 ? names.join(", ") : "none";
  return `cannot run ${modelId} on this runner: set AI_GATEWAY_API_KEY, or install the @ai-sdk/${provider} package and set its API key (callable providers: ${listed})`;
}

/** Room left for the envelope fields (v, type, id, ts, runId, seq) of one frame. */
const ENVELOPE_ALLOWANCE = 1024;

/** Cuts the largest fields of a payload, one at a time, until it fits in budget. */
function shrink<T extends object>(payload: T, budget: number): T {
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  const fields = Object.keys(out).sort((a, b) => jsonBytes(out[b]) - jsonBytes(out[a]));
  for (const field of fields) {
    const over = jsonBytes(out) - budget;
    if (over <= 0) break;
    const value = out[field];
    const target = Math.max(256, jsonBytes(value) - over);
    out[field] =
      typeof value === "string" ? truncateText(value, target) : truncateValue(value, target);
  }
  return out as T;
}
