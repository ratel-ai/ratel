import { type EvidenceSample, emptyMix } from "@/lib/readings/trace-signals/signals/accumulators";
import {
  EVIDENCE_TURNS_STORED,
  LATENCY_RESERVOIR_SIZE,
} from "@/lib/readings/trace-signals/signals/catalog";
import {
  type OtelFacts,
  type OtelStepFact,
  type OtelTraceFact,
  otelTraceIdOf,
  type StartedBy,
} from "@/lib/readings/trace-signals/signals/otel-facts";
import { Reservoir } from "@/lib/readings/trace-signals/signals/severity";
import { type InvokeStep, isInvoke } from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Pass one of the OTel signals: a streaming walk over the window's turns that
 * reads each OTLP-lane turn's tool calls together with what OTLP ingest
 * recorded beside them ({@link OtelFacts}). A sibling of `accumulators.ts`,
 * kept apart so the search-era counters stay exactly as they were.
 *
 * Memory is bounded by distinct tool names, ordered tool pairs that switched,
 * and distinct per-turn model-call counts (capped), never by turns. As in
 * `accumulators.ts`, the counters are mutated in place while the stream runs
 * and only read once it ends.
 */

/** Model-call counts above this share one bucket. */
const MAX_MODEL_CALL_BUCKET = 10_000;

export interface OtelToolStats {
  id: string;
  /** OTLP-lane turns that call the tool. */
  turns: number;
  calls: number;
  okCalls: number;
  /** Ok calls whose result was captured, and those that came back empty. */
  captured: number;
  empty: number;
  /** Calls failing with a tool-not-found error type. */
  unknownByError: number;
  /** Calls of a tool missing from its trace's captured menu. */
  unknownByMenu: number;
  /** Calls counted by both of the above, and the turns that had a call of each kind. */
  unknownByBoth: number;
  errorTurns: number;
  menuTurnsUnknown: number;
  bothTurns: number;
  /** Model calls whose captured menu offered the tool (see `addMenus`). */
  menuCalls: number;
  menuTurns: number;
  mix: TurnSourceMix;
  emptyEvidence: Reservoir<EvidenceSample>;
  errorEvidence: Reservoir<EvidenceSample>;
  menuEvidence: Reservoir<EvidenceSample>;
  /** Calls refused for permission, plan or budget (`blocked_action`), the turns that had one, and the codes. */
  blockedCalls: number;
  blockedTurns: number;
  blockedCodes: Map<string, number>;
  blockedEvidence: Reservoir<EvidenceSample>;
  /** Turns where a call failed, and those where the same call was then sent again unchanged (`identical_retry`). */
  failedTurns: number;
  retryTurns: number;
  retryEvidence: Reservoir<EvidenceSample>;
  /** Time spent inside the tool across its timed calls (`wait_heavy`). */
  timedCalls: number;
  timeMs: number;
  durations: Reservoir<number>;
  timeEvidence: Reservoir<EvidenceSample>;
}

export interface SwitchStats {
  from: string;
  to: string;
  /** Turns with the switch (counted once per turn). */
  turns: number;
  byError: number;
  byEmpty: number;
  evidence: Reservoir<EvidenceSample>;
}

export interface ModelCallBucket {
  turns: number;
  inputTokens: number;
  /** Turns of this bucket each tool ran in. */
  toolTurns: Map<string, number>;
  evidence: Reservoir<EvidenceSample>;
}

export interface OtelStats {
  /** OTLP-lane turns in the window. */
  otlpTurns: number;
  mix: TurnSourceMix;
  /** SDK runs in the window linked to OpenTelemetry model calls (`linked-runs.ts`). */
  linkedTurns: number;
  linkedMix: TurnSourceMix;
  /** Tools run in the window on any lane. */
  calledTools: Set<string>;
  tools: Map<string, OtelToolStats>;
  switches: Map<string, SwitchStats>;
  capturedResults: number;
  /** OTLP-lane turns whose trace carried a captured tool menu. */
  menuTurns: number;
  /** OTLP-lane turns whose trace had at least one model call. */
  modelTurns: number;
  /** By model calls per turn. */
  buckets: Map<number, ModelCallBucket>;
  /** Tool calls whose arguments were captured (`identical_retry` is measured only then). */
  argCalls: number;
  /** Wall time of the OTLP-lane turns, the base of a tool's share of time (`wait_heavy`). */
  turnMs: number;
  /** Turns by input tokens, in powers-of-two buckets (`token_heavy`). */
  tokenBuckets: Map<number, TokenBucket>;
  tokenTurns: number;
  /** OTLP-lane turns by who started them, when a prompt was captured (`system_turn_failing`). */
  started: Record<StartedBy, StartedStats>;
  /** Tool calls by the agent that made them, when the spans name it (`agent_failing`). */
  agents: Map<string, AgentStats>;
}

export interface StartedStats {
  turns: number;
  /** Turns with at least one failed tool call. */
  failedTurns: number;
  durations: Reservoir<number>;
  failedEvidence: Reservoir<EvidenceSample>;
}

export interface AgentStats {
  id: string;
  turns: number;
  calls: number;
  failedCalls: number;
  /** Failed calls per tool, to name the tools behind an agent's failures. */
  toolFailures: Map<string, number>;
  failedEvidence: Reservoir<EvidenceSample>;
}

export interface TokenBucket {
  turns: number;
  tokens: number;
  max: number;
  evidence: Reservoir<EvidenceSample>;
}

export function createOtelStats(): OtelStats {
  return {
    otlpTurns: 0,
    mix: emptyMix(),
    linkedTurns: 0,
    linkedMix: emptyMix(),
    calledTools: new Set(),
    tools: new Map(),
    switches: new Map(),
    capturedResults: 0,
    menuTurns: 0,
    modelTurns: 0,
    buckets: new Map(),
    argCalls: 0,
    turnMs: 0,
    tokenBuckets: new Map(),
    tokenTurns: 0,
    started: { system: startedStats("system"), person: startedStats("person") },
    agents: new Map(),
  };
}

function startedStats(by: StartedBy): StartedStats {
  return {
    turns: 0,
    failedTurns: 0,
    durations: new Reservoir<number>(LATENCY_RESERVOIR_SIZE, `otel:started:${by}:durations`),
    failedEvidence: new Reservoir<EvidenceSample>(
      EVIDENCE_TURNS_STORED,
      `otel:started:${by}:failed`,
    ),
  };
}

/** Error types that say the tool itself does not exist. */
export const UNKNOWN_TOOL_ERROR = /not[_ ]?found|unknown[_ ]?tool|no such tool|invalid[_ ]?tool/i;

/**
 * Error types from a result that reported its own failure (`derive-tools.ts`,
 * `result:<http>:<code>`). Such a tool ran, so a "not found" in it is about the
 * thing it looked for, never the tool.
 */
const RESULT_ERROR = /^result(?::|$)/;

/**
 * Error types that say the agent may not do this: a 401 or 403, or a code
 * about permission, plan or budget. The agent asked for something its access
 * does not cover, so retrying cannot help.
 */
export const BLOCKED_ERROR =
  /\bhttp_40[13]\b|forbidden|denied|unauthori[sz]ed|not_?(?:allowed|permitted|declared|authori[sz]ed)|permission|insufficient_(?:credits?|funds|balance|quota)|quota_exceeded|over_?budget|budget_exceeded|plan_limit/i;

/** The error code a blocked call named, for the card: the last part of a result type, or the whole type. */
export function blockedCodeOf(errorType: string): string {
  return RESULT_ERROR.test(errorType) ? (errorType.split(":").at(-1) ?? errorType) : errorType;
}

function sample(turn: SignalTurn, eventId: string | null): EvidenceSample {
  return { turnId: turn.id, eventId, at: turn.endedAt.getTime(), source: turn.turnSource };
}

function toolOf(stats: OtelStats, id: string): OtelToolStats {
  const known = stats.tools.get(id);
  if (known) return known;
  const created: OtelToolStats = {
    id,
    turns: 0,
    calls: 0,
    okCalls: 0,
    captured: 0,
    empty: 0,
    unknownByError: 0,
    unknownByMenu: 0,
    unknownByBoth: 0,
    errorTurns: 0,
    menuTurnsUnknown: 0,
    bothTurns: 0,
    menuCalls: 0,
    menuTurns: 0,
    mix: emptyMix(),
    emptyEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:empty`),
    errorEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:unknown_error`),
    menuEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:unknown_menu`),
    blockedCalls: 0,
    blockedTurns: 0,
    blockedCodes: new Map(),
    blockedEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:blocked`),
    failedTurns: 0,
    retryTurns: 0,
    retryEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:retry`),
    timedCalls: 0,
    timeMs: 0,
    durations: new Reservoir(LATENCY_RESERVOIR_SIZE, `otel:${id}:durations`),
    timeEvidence: new Reservoir(EVIDENCE_TURNS_STORED, `otel:${id}:time`),
  };
  stats.tools.set(id, created);
  return created;
}

const toolCalls = (turn: SignalTurn): InvokeStep[] =>
  turn.steps.filter((step): step is InvokeStep => isInvoke(step) && step.targetType === "tool");

/** Feed one closed turn inside the window. Only OTLP-lane turns count, beyond the called-tool set. */
export function accumulateOtelTurn(stats: OtelStats, turn: SignalTurn, facts: OtelFacts): void {
  const calls = toolCalls(turn);
  for (const call of calls) stats.calledTools.add(call.targetId);
  if (turn.lane !== "otlp") {
    if (turn.linked) addLinkedRun(stats, turn, calls, turn.linked);
    return;
  }
  stats.otlpTurns += 1;
  stats.mix[turn.turnSource] += 1;
  const traceId = otelTraceIdOf(turn);
  const trace = traceId ? facts.traces.get(traceId) : undefined;
  const factOf = (step: InvokeStep): OtelStepFact | undefined =>
    facts.stepFacts.get(step.traceEventId);
  addCalls(stats, turn, calls, factOf, trace);
  addSwitches(stats, turn, calls, factOf);
  addRetries(stats, turn, calls, factOf);
  addTime(stats, turn, calls);
  addAgents(stats, turn, calls, factOf);
  if (trace?.startedBy) addStarted(stats, turn, calls, trace.startedBy);
  if (trace) {
    addMenus(stats, trace);
    addModelCalls(stats, turn, calls, trace);
  }
}

/**
 * An SDK run linked to its model calls counts toward the two model-call
 * signals (long runs, tools offered and never used) as an OTel trace would.
 * The tool-call signals stay with the OTLP lane, whose calls they read.
 */
function addLinkedRun(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  linked: OtelTraceFact,
): void {
  stats.linkedTurns += 1;
  stats.linkedMix[turn.turnSource] += 1;
  addMenus(stats, linked);
  addModelCalls(stats, turn, calls, linked);
}

/** The mix behind the model-call signals: OTLP-lane turns and linked SDK runs. */
export function modelMixOf(stats: Pick<OtelStats, "mix" | "linkedMix">): TurnSourceMix {
  return {
    declared: stats.mix.declared + stats.linkedMix.declared,
    inferred: stats.mix.inferred + stats.linkedMix.inferred,
    otlp: stats.mix.otlp + stats.linkedMix.otlp,
  };
}

function addCalls(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  factOf: (step: InvokeStep) => OtelStepFact | undefined,
  trace: OtelTraceFact | undefined,
): void {
  const flagged = new Set<string>();
  for (const call of calls) {
    const tool = toolOf(stats, call.targetId);
    const fact = factOf(call);
    tool.calls += 1;
    if (call.outcome === "ok") {
      tool.okCalls += 1;
      addResult(stats, tool, fact, () =>
        once(flagged, `empty:${tool.id}`, () =>
          tool.emptyEvidence.add(sample(turn, call.traceEventId)),
        ),
      );
    }
    const errorType = call.outcome === "error" ? (fact?.errorType ?? "") : "";
    const byError =
      errorType !== "" && !RESULT_ERROR.test(errorType) && UNKNOWN_TOOL_ERROR.test(errorType);
    if (fact?.argHash) stats.argCalls += 1;
    if (errorType !== "" && BLOCKED_ERROR.test(errorType)) {
      tool.blockedCalls += 1;
      const code = blockedCodeOf(errorType);
      tool.blockedCodes.set(code, (tool.blockedCodes.get(code) ?? 0) + 1);
      once(flagged, `blocked:${tool.id}`, () =>
        tool.blockedEvidence.add(sample(turn, call.traceEventId)),
      );
    }
    const byMenu = trace !== undefined && trace.menuCalls > 0 && !trace.menus.has(call.targetId);
    if (byError) {
      tool.unknownByError += 1;
      once(flagged, `error:${tool.id}`, () =>
        tool.errorEvidence.add(sample(turn, call.traceEventId)),
      );
    }
    if (byMenu) {
      tool.unknownByMenu += 1;
      once(flagged, `menu:${tool.id}`, () =>
        tool.menuEvidence.add(sample(turn, call.traceEventId)),
      );
    }
    if (byError && byMenu) tool.unknownByBoth += 1;
  }
  for (const id of new Set(calls.map((call) => call.targetId))) {
    const tool = toolOf(stats, id);
    tool.turns += 1;
    tool.mix[turn.turnSource] += 1;
    const error = flagged.has(`error:${id}`);
    const menu = flagged.has(`menu:${id}`);
    if (error) tool.errorTurns += 1;
    if (menu) tool.menuTurnsUnknown += 1;
    if (error && menu) tool.bothTurns += 1;
    if (flagged.has(`blocked:${id}`)) tool.blockedTurns += 1;
  }
}

/**
 * A failed call sent again later in the same turn with the same arguments,
 * counted once per tool per turn, among the turns where the tool failed. Read
 * only from calls whose arguments were captured.
 */
function addRetries(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  factOf: (step: InvokeStep) => OtelStepFact | undefined,
): void {
  const failed = new Map<string, string | null>();
  const retried = new Set<string>();
  calls.forEach((call, i) => {
    if (call.outcome !== "error") return;
    if (!failed.has(call.targetId)) failed.set(call.targetId, call.traceEventId);
    const args = factOf(call)?.argHash;
    if (!args || retried.has(call.targetId)) return;
    const again = calls
      .slice(i + 1)
      .some((next) => next.targetId === call.targetId && factOf(next)?.argHash === args);
    if (again) retried.add(call.targetId);
  });
  for (const [id, eventId] of failed) {
    const tool = toolOf(stats, id);
    tool.failedTurns += 1;
    if (!retried.has(id)) continue;
    tool.retryTurns += 1;
    tool.retryEvidence.add(sample(turn, eventId));
  }
}

/** The turn's wall time, and each tool's time inside its calls. */
function addTime(stats: OtelStats, turn: SignalTurn, calls: readonly InvokeStep[]): void {
  const turnMs = turn.endedAt.getTime() - turn.startedAt.getTime();
  if (Number.isFinite(turnMs) && turnMs > 0) stats.turnMs += turnMs;
  const sampled = new Set<string>();
  for (const call of calls) {
    if (call.tookMs === null || call.tookMs < 0) continue;
    const tool = toolOf(stats, call.targetId);
    tool.timedCalls += 1;
    tool.timeMs += call.tookMs;
    tool.durations.add(call.tookMs);
    once(sampled, call.targetId, () => tool.timeEvidence.add(sample(turn, call.traceEventId)));
  }
}

/** An ok call's captured result, empty or not; `onEmpty` samples the turn. */
function addResult(
  stats: OtelStats,
  tool: OtelToolStats,
  fact: OtelStepFact | undefined,
  onEmpty: () => void,
): void {
  if (fact?.resultEmpty == null) return;
  tool.captured += 1;
  stats.capturedResults += 1;
  if (!fact.resultEmpty) return;
  tool.empty += 1;
  onEmpty();
}

/** Runs `effect` the first time `key` is seen: one evidence sample per turn and reason. */
function once(seen: Set<string>, key: string, effect: () => void): void {
  if (seen.has(key)) return;
  seen.add(key);
  effect();
}

/**
 * A call that failed or came back empty, followed at once by a call of a
 * different tool that succeeded (with a non-empty result when captured).
 * Counted once per ordered pair per turn.
 */
function addSwitches(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  factOf: (step: InvokeStep) => OtelStepFact | undefined,
): void {
  const seen = new Set<string>();
  calls.forEach((call, i) => {
    const next = calls[i + 1];
    if (!next || next.targetId === call.targetId) return;
    const failed = call.outcome === "error";
    const empty = call.outcome === "ok" && factOf(call)?.resultEmpty === true;
    if (!failed && !empty) return;
    if (next.outcome !== "ok" || factOf(next)?.resultEmpty === true) return;
    const key = `${call.targetId}>${next.targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const pair = stats.switches.get(key) ?? {
      from: call.targetId,
      to: next.targetId,
      turns: 0,
      byError: 0,
      byEmpty: 0,
      evidence: new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, `otel:switch:${key}`),
    };
    pair.turns += 1;
    if (failed) pair.byError += 1;
    else pair.byEmpty += 1;
    pair.evidence.add(sample(turn, call.traceEventId));
    stats.switches.set(key, pair);
  });
}

/**
 * Menus are kept per trace as a union with a count of the model calls that
 * carried one, so a tool's `menuCalls` adds the trace's count when the union
 * holds it. Exact when every model call of a trace carries the same menu (the
 * usual case); an upper bound otherwise.
 */
function addMenus(stats: OtelStats, trace: OtelTraceFact): void {
  if (trace.menuCalls === 0) return;
  stats.menuTurns += 1;
  for (const name of trace.menus) {
    const tool = toolOf(stats, name);
    tool.menuCalls += trace.menuCalls;
    tool.menuTurns += 1;
  }
}

function addModelCalls(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  trace: OtelTraceFact,
): void {
  if (trace.modelCalls === 0) return;
  stats.modelTurns += 1;
  addTokens(stats, turn, calls, trace.inputTokens);
  const key = Math.min(trace.modelCalls, MAX_MODEL_CALL_BUCKET);
  const bucket = stats.buckets.get(key) ?? {
    turns: 0,
    inputTokens: 0,
    toolTurns: new Map<string, number>(),
    evidence: new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, `otel:model_calls:${key}`),
  };
  bucket.turns += 1;
  bucket.inputTokens += trace.inputTokens;
  for (const id of new Set(calls.map((call) => call.targetId))) {
    bucket.toolTurns.set(id, (bucket.toolTurns.get(id) ?? 0) + 1);
  }
  bucket.evidence.add(sample(turn, calls[0]?.traceEventId ?? turn.steps[0]?.traceEventId ?? null));
  stats.buckets.set(key, bucket);
}

/** A turn's input tokens, in the power-of-two bucket that holds them. */
function addTokens(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  tokens: number,
): void {
  if (!(tokens > 0)) return;
  stats.tokenTurns += 1;
  const key = Math.floor(Math.log2(tokens));
  const bucket = stats.tokenBuckets.get(key) ?? {
    turns: 0,
    tokens: 0,
    max: 0,
    evidence: new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, `otel:tokens:${key}`),
  };
  bucket.turns += 1;
  bucket.tokens += tokens;
  bucket.max = Math.max(bucket.max, tokens);
  bucket.evidence.add(sample(turn, calls[0]?.traceEventId ?? turn.steps[0]?.traceEventId ?? null));
  stats.tokenBuckets.set(key, bucket);
}

/** A turn by who started it: whether a tool call failed in it, and how long it ran. */
function addStarted(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  by: StartedBy,
): void {
  const started = stats.started[by];
  started.turns += 1;
  const ms = turn.endedAt.getTime() - turn.startedAt.getTime();
  if (Number.isFinite(ms) && ms >= 0) started.durations.add(ms);
  const failed = calls.find((call) => call.outcome === "error");
  if (!failed) return;
  started.failedTurns += 1;
  started.failedEvidence.add(sample(turn, failed.traceEventId));
}

/** Each named agent's tool calls in the turn, counted once per turn for `turns`. */
function addAgents(
  stats: OtelStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  factOf: (step: InvokeStep) => OtelStepFact | undefined,
): void {
  const seen = new Set<string>();
  for (const call of calls) {
    const name = factOf(call)?.agent;
    if (!name) continue;
    const agent = stats.agents.get(name) ?? {
      id: name,
      turns: 0,
      calls: 0,
      failedCalls: 0,
      toolFailures: new Map<string, number>(),
      failedEvidence: new Reservoir<EvidenceSample>(
        EVIDENCE_TURNS_STORED,
        `otel:agent:${name}:failed`,
      ),
    };
    stats.agents.set(name, agent);
    agent.calls += 1;
    if (!seen.has(name)) {
      seen.add(name);
      agent.turns += 1;
    }
    if (call.outcome !== "error") continue;
    agent.failedCalls += 1;
    agent.toolFailures.set(call.targetId, (agent.toolFailures.get(call.targetId) ?? 0) + 1);
    once(seen, `failed:${name}`, () => agent.failedEvidence.add(sample(turn, call.traceEventId)));
  }
}
