import { DEFAULT_TURN_CONFIG, type TurnConfig } from "@/lib/ledger/constants";
import { DEV_TRACE_SIGNALS_HASH_SALT } from "@/lib/ledger/hash";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type {
  NormalizedEvent,
  StoredTurn,
  TurnDraft,
  TurnEventHit,
  TurnEventRow,
  TurnLane,
} from "@/lib/ledger/types";

/**
 * Test fixtures for the turn ledger and the signal detectors built on it.
 *
 *   turn().search(["a", "b", "c"]).invoke("b").error("b")
 *
 * reads as one agent turn: a search listing a, b, c, then b is run and fails.
 * Each call appends events one `stepMs` apart. `invoke(tool)` emits the start;
 * unless `end`/`error` for that tool follows directly, the next call (or
 * reading the fixture) closes it with a successful end first, so
 * `turn().search(["a"]).invoke("a").search(["b"]).invoke("b")` is two ok calls.
 * Pass `{ open: true }` for a start that never ends (outcome unknown).
 *
 * Several turns of one session: `turn({ after: first, gapMs: 30_000 })` carries
 * the session, source and clock on. Receipt times only ever move forward, so
 * `at(ms)` to an earlier time makes a backwards clock.
 *
 * `buildFixtureTurns(fixtures)` runs the whole pure pipeline and returns the
 * `TurnDraft`s a detector reads; by default its clock is past the idle close,
 * so every turn comes back closed.
 */

const BASE_TIME = Date.parse("2026-09-01T09:00:00Z");
let idCounter = 0;
let sessionCounter = 0;

/** A fresh uuid-shaped id, unique within the process. */
export function fixtureId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}

export interface TurnFixtureOptions {
  session?: string;
  source?: string | null;
  /** A host-declared turn id; every event carries it. */
  turnId?: string | null;
  endUser?: string | null;
  lane?: TurnLane;
  traceId?: string | null;
  /** Event time of the first event (epoch ms or Date). */
  start?: number | Date;
  /** Continue after another fixture: same session, source and end user. */
  after?: TurnFixture;
  /** With `after`, the silence before this turn's first event. */
  gapMs?: number;
  /** Time between consecutive calls. */
  stepMs?: number;
}

export interface SearchOptions {
  query?: string;
  topK?: number;
  scores?: readonly number[];
}

export interface InvokeOptions {
  invocationId?: string | null;
  tookMs?: number;
  /** A start that never ends. */
  open?: boolean;
}

interface Pending {
  tool: string;
  invocationId: string | null;
}

export class TurnFixture {
  readonly session: string;
  readonly source: string | null;
  readonly turnId: string | null;
  readonly endUser: string | null;
  readonly lane: TurnLane;
  readonly traceId: string | null;
  private readonly stepMs: number;
  private readonly events: TurnEventRow[] = [];
  private readonly hitRows = new Map<string, TurnEventHit[]>();
  private pending: Pending[] = [];
  private clockMs: number;
  private receivedMs: number;
  private started = false;

  constructor(opts: TurnFixtureOptions = {}) {
    const prior = opts.after;
    // Close the prior fixture's pending calls so the gap counts from its last event.
    prior?.rows();
    this.session = opts.session ?? prior?.session ?? `session-${++sessionCounter}`;
    this.source = opts.source !== undefined ? opts.source : (prior?.source ?? "app");
    this.turnId = opts.turnId ?? null;
    this.endUser = opts.endUser !== undefined ? opts.endUser : (prior?.endUser ?? null);
    this.lane = opts.lane ?? prior?.lane ?? "runtime";
    this.traceId = opts.traceId ?? null;
    this.stepMs = opts.stepMs ?? 1_000;
    const start = opts.start instanceof Date ? opts.start.getTime() : opts.start;
    this.clockMs = start ?? (prior ? prior.lastOccurredMs + (opts.gapMs ?? 10_000) : BASE_TIME);
    this.receivedMs = prior?.lastReceivedMs ?? 0;
  }

  /** Event time of the latest event. */
  get lastOccurredMs(): number {
    return this.clockMs;
  }

  /** Receipt time of the latest event. */
  get lastReceivedMs(): number {
    return this.receivedMs;
  }

  search(hits: readonly string[], opts: SearchOptions = {}): this {
    return this.searchOf("search", "tool", hits, opts);
  }

  skillSearch(hits: readonly string[], opts: SearchOptions = {}): this {
    return this.searchOf("skill_search", "skill", hits, opts);
  }

  gatewaySearch(hitCount: number, opts: SearchOptions = {}): this {
    this.flush();
    this.push("gateway_search", {
      query: opts.query ?? "gateway query",
      topK: opts.topK ?? null,
      hitCount,
    });
    return this;
  }

  invoke(tool: string, opts: InvokeOptions = {}): this {
    this.flush();
    const invocationId = opts.invocationId ?? null;
    this.push("invoke_start", { toolId: tool, invocationId });
    if (!opts.open) this.pending = [...this.pending, { tool, invocationId }];
    return this;
  }

  end(tool: string, opts: InvokeOptions = {}): this {
    return this.close("invoke_end", tool, opts);
  }

  error(tool: string, opts: InvokeOptions = {}): this {
    return this.close("invoke_error", tool, opts);
  }

  skill(skillId: string, opts: InvokeOptions = {}): this {
    this.flush();
    this.push("skill_invoke", { skillId, tookMs: opts.tookMs ?? 120 });
    return this;
  }

  gatewayInvoke(tool: string, opts: InvokeOptions = {}): this {
    this.flush();
    this.push("gateway_invoke", { toolId: tool, tookMs: opts.tookMs ?? 120 });
    return this;
  }

  gatewayError(tool: string): this {
    this.flush();
    this.push("gateway_error", { toolId: tool });
    return this;
  }

  /** Let `ms` pass before the next call. */
  wait(ms: number): this {
    this.clockMs += ms;
    return this;
  }

  /** Put the next call at this event time, earlier or later than the last. */
  at(epochMs: number | Date): this {
    const target = epochMs instanceof Date ? epochMs.getTime() : epochMs;
    this.clockMs = this.started ? target - this.stepMs : target;
    return this;
  }

  /** The fixture's `trace_events` rows, closing any pending invocation first. */
  rows(): TurnEventRow[] {
    this.flush();
    return [...this.events];
  }

  /** The fixture's `trace_event_hits`, keyed by search event id. */
  hits(): Map<string, TurnEventHit[]> {
    return new Map(this.hitRows);
  }

  private searchOf(
    type: "search" | "skill_search",
    targetType: "tool" | "skill",
    hits: readonly string[],
    opts: SearchOptions,
  ): this {
    this.flush();
    const id = this.push(type, {
      query: opts.query ?? `query ${hits.join(" ")}`,
      topK: opts.topK ?? Math.max(hits.length, 1),
      hitCount: hits.length,
    });
    this.hitRows.set(
      id,
      hits.map((targetId, rank) => ({
        rank,
        targetType,
        targetId,
        score: opts.scores?.[rank] ?? 1 - rank / 100,
      })),
    );
    return this;
  }

  private close(type: "invoke_end" | "invoke_error", tool: string, opts: InvokeOptions): this {
    const match = this.pending.find((p) => p.tool === tool);
    this.pending = this.pending.filter((p) => p !== match);
    this.flush();
    this.push(type, {
      toolId: tool,
      invocationId: opts.invocationId ?? match?.invocationId ?? null,
      tookMs: opts.tookMs ?? 120,
    });
    return this;
  }

  /** Close every pending invocation with a successful end. */
  private flush(): void {
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) {
      this.push("invoke_end", { toolId: p.tool, invocationId: p.invocationId, tookMs: 120 });
    }
  }

  private push(type: string, fields: Partial<TurnEventRow>): string {
    this.clockMs = this.started ? this.clockMs + this.stepMs : this.clockMs;
    this.started = true;
    this.receivedMs = Math.max(this.clockMs, this.receivedMs + 1);
    const id = fixtureId();
    this.events.push({
      id,
      type,
      sessionId: this.session,
      sourceId: this.source,
      ingestSource: this.lane,
      occurredAt: new Date(this.clockMs),
      receivedAt: new Date(this.receivedMs),
      turnId: this.turnId,
      invocationId: null,
      traceId: this.traceId,
      toolId: null,
      skillId: null,
      query: null,
      topK: null,
      hitCount: null,
      tookMs: null,
      endUserId: this.endUser,
      ...fields,
    });
    return id;
  }
}

export function turn(opts: TurnFixtureOptions = {}): TurnFixture {
  return new TurnFixture(opts);
}

/** Every fixture's rows and hits, merged. */
export function fixtureRows(fixtures: readonly TurnFixture[]): {
  rows: TurnEventRow[];
  hits: Map<string, TurnEventHit[]>;
} {
  const rows = fixtures.flatMap((f) => f.rows());
  const hits = new Map(fixtures.flatMap((f) => [...f.hits()]));
  return { rows, hits };
}

export function fixtureEvents(
  fixtures: readonly TurnFixture[],
  salt: string = DEV_TRACE_SIGNALS_HASH_SALT,
): NormalizedEvent[] {
  const { rows, hits } = fixtureRows(fixtures);
  return normalizeEvents(rows, hits, { salt });
}

export interface BuildFixtureOptions {
  /** Defaults to just past the idle close of the latest event: all turns closed. */
  now?: Date;
  config?: TurnConfig;
  salt?: string;
}

/** Run the pure pipeline over fixtures and return the turns a detector reads. */
export function buildFixtureTurns(
  fixtures: readonly TurnFixture[],
  opts: BuildFixtureOptions = {},
): TurnDraft[] {
  const config = opts.config ?? DEFAULT_TURN_CONFIG;
  const events = fixtureEvents(fixtures, opts.salt);
  const latest = events.reduce((max, e) => Math.max(max, e.receivedAt), 0);
  const now = opts.now ?? new Date(latest + config.idleCloseMs + 1);
  return buildTurns({ stored: [], events, now, config }).turns;
}

/** A built turn as the ledger would hand it back for re-derivation. */
export function asStoredTurn(turn: TurnDraft, id: string = fixtureId()): StoredTurn {
  return {
    id,
    sessionId: turn.sessionId,
    sourceId: turn.sourceId,
    turnKey: turn.turnKey,
    turnSource: turn.turnSource,
    lane: turn.lane,
    endUserKey: turn.endUserKey,
    steps: turn.steps,
  };
}
