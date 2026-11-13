import { costFor } from "@/lib/ingest/pricing";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Linking SDK runs to the OpenTelemetry model calls of the same agent.
 *
 * When an OTel span is active, the Ratel SDK stamps its trace id on the run's
 * events: a model call of one of those traces belongs to that run, whatever
 * its session (the nearest such run in time if a trace spans several).
 * Otherwise a run on the runtime lane and the model-call spans an OTel
 * exporter sends for it share only the session (the
 * SDK `session_id` equals OTel `gen_ai.conversation.id` or `session.id`) and
 * the clock. A model call belongs to an SDK run of its session when it starts
 * inside `[run start - LINK_LEAD_MS, run end + LINK_TAIL_MS]`. A model call
 * that starts after that, within `LINK_TAIL_MS` of the end of the run's
 * previous linked call (the model still working, as on a run that thinks for
 * many rounds after its last tool call), stays with the run, up to
 * `LINK_CHAIN_MAX_MS` past its end and never once the session's next run has
 * started. Each model call joins one run at most: the nearest.
 *
 * What a linked run gains: its model calls, tokens, cost (priced by
 * `costFor` with the stored model), time in the model, the user's captured
 * ask, and the tools the model was offered. Pure; the read lives in
 * `linked-runs-query.ts`.
 */

export const LINK_LEAD_MS = 5_000;
export const LINK_TAIL_MS = 5_000;
export const LINK_CHAIN_MAX_MS = 120_000;

/** One stored model call that may belong to an SDK run. */
export interface LinkCandidate {
  id: string;
  sessionId: string;
  atMs: number;
  tookMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  prompt: string | null;
  menu: readonly string[] | null;
  /** The call's trace, for linking by the trace ids the SDK stamped on a run. */
  traceId?: string | null;
}

/** Run id -> the trace ids its SDK events carried. */
export type RunTraces = ReadonlyMap<string, ReadonlySet<string>>;

/** What an SDK run gains from its linked model calls. */
export interface LinkedRunFact {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Summed over the priced calls; null when no call's model has a price. */
  costUsd: number | null;
  /** Summed model-call durations, ms. */
  modelMs: number;
  /** The first captured ask; null when content capture is off. */
  prompt: string | null;
  /** Union of the tool names offered across the calls. */
  menus: Set<string>;
  /** Calls that carried a captured tool menu. */
  menuCalls: number;
  /** First call start and last call end, epoch ms. */
  firstAtMs: number;
  lastEndMs: number;
}

export type LinkTurn = Pick<SignalTurn, "id" | "sessionId" | "startedAt" | "endedAt">;

const endOf = (call: LinkCandidate): number => call.atMs + Math.max(0, call.tookMs ?? 0);

function distance(turn: LinkTurn, at: number): number {
  if (at < turn.startedAt.getTime()) return turn.startedAt.getTime() - at;
  if (at > turn.endedAt.getTime()) return at - turn.endedAt.getTime();
  return 0;
}

function inWindow(turn: LinkTurn, at: number): boolean {
  return (
    at >= turn.startedAt.getTime() - LINK_LEAD_MS && at <= turn.endedAt.getTime() + LINK_TAIL_MS
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

/** The run a call starting at `at` keeps working in, by the chain rule; undefined otherwise. */
function chainedTurn(
  turns: readonly LinkTurn[],
  at: number,
  lastEnd: ReadonlyMap<string, number>,
): LinkTurn | undefined {
  const index = turns.findLastIndex((turn) => turn.startedAt.getTime() <= at);
  const turn = turns[index];
  const next = turns[index + 1];
  const previousEnd = turn ? lastEnd.get(turn.id) : undefined;
  if (!turn || previousEnd === undefined) return undefined;
  if (at > previousEnd + LINK_TAIL_MS || at > turn.endedAt.getTime() + LINK_CHAIN_MAX_MS)
    return undefined;
  return next && at >= next.startedAt.getTime() - LINK_LEAD_MS ? undefined : turn;
}

function assignSession(
  turns: readonly LinkTurn[],
  calls: readonly LinkCandidate[],
  out: Map<string, LinkCandidate[]>,
): void {
  const ordered = [...turns].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  // Calls already linked by trace id keep a run's chain going too.
  const lastEnd = new Map<string, number>();
  for (const turn of ordered) {
    const linked = out.get(turn.id);
    if (linked && linked.length > 0) lastEnd.set(turn.id, Math.max(...linked.map(endOf)));
  }
  for (const call of [...calls].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1))) {
    const direct = ordered
      .filter((turn) => inWindow(turn, call.atMs))
      .sort((a, b) => distance(a, call.atMs) - distance(b, call.atMs))[0];
    const turn = direct ?? chainedTurn(ordered, call.atMs, lastEnd);
    if (!turn) continue;
    out.set(turn.id, [...(out.get(turn.id) ?? []), call]);
    lastEnd.set(turn.id, Math.max(lastEnd.get(turn.id) ?? 0, endOf(call)));
  }
}

/** Calls whose trace one of the runs carried, each to the nearest such run; the rest are returned. */
function assignByTrace(
  turns: readonly LinkTurn[],
  calls: readonly LinkCandidate[],
  runTraces: RunTraces,
  out: Map<string, LinkCandidate[]>,
): LinkCandidate[] {
  const byTrace = new Map<string, LinkTurn[]>();
  for (const turn of turns) {
    for (const traceId of runTraces.get(turn.id) ?? [])
      byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), turn]);
  }
  if (byTrace.size === 0) return [...calls];
  const rest: LinkCandidate[] = [];
  for (const call of calls) {
    const owners = call.traceId ? byTrace.get(call.traceId) : undefined;
    const turn = owners
      ?.slice()
      .sort((a, b) => distance(a, call.atMs) - distance(b, call.atMs) || (a.id < b.id ? -1 : 1))[0];
    if (turn) out.set(turn.id, [...(out.get(turn.id) ?? []), call]);
    else rest.push(call);
  }
  return rest;
}

/**
 * Each run's model calls, by run id. A call joins one run at most: by trace
 * id first (`runTraces`), else by session and time.
 */
export function assignModelCalls(
  turns: readonly LinkTurn[],
  calls: readonly LinkCandidate[],
  runTraces: RunTraces = new Map(),
): Map<string, LinkCandidate[]> {
  const out = new Map<string, LinkCandidate[]>();
  const rest = assignByTrace(turns, calls, runTraces, out);
  const callsBySession = groupBy(rest, (call) => call.sessionId);
  for (const [sessionId, sessionTurns] of groupBy(turns, (turn) => turn.sessionId)) {
    const sessionCalls = callsBySession.get(sessionId);
    if (sessionCalls) assignSession(sessionTurns, sessionCalls, out);
  }
  return out;
}

const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/** The facts of one run's linked calls (at least one). */
export function linkedFactOf(calls: readonly LinkCandidate[]): LinkedRunFact {
  const ordered = [...calls].sort((a, b) => a.atMs - b.atMs);
  const costs = ordered.flatMap((call) => {
    const usd = costFor(call.model, {
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
    });
    return usd === null ? [] : [usd];
  });
  const menus = ordered.map((call) =>
    (call.menu ?? []).filter((name) => typeof name === "string" && name.length > 0),
  );
  return {
    modelCalls: ordered.length,
    inputTokens: ordered.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: ordered.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    costUsd: costs.length > 0 ? roundUsd(costs.reduce((sum, usd) => sum + usd, 0)) : null,
    modelMs: ordered.reduce((sum, call) => sum + Math.max(0, call.tookMs ?? 0), 0),
    prompt: ordered.find((call) => call.prompt)?.prompt ?? null,
    menus: new Set(menus.flat()),
    menuCalls: menus.filter((menu) => menu.length > 0).length,
    firstAtMs: ordered[0]?.atMs ?? 0,
    lastEndMs: Math.max(...ordered.map(endOf)),
  };
}

/** The page's turns, each runtime-lane run that linked a model call carrying `linked`. */
export function linkTurns(
  turns: readonly SignalTurn[],
  calls: readonly LinkCandidate[],
  runTraces: RunTraces = new Map(),
): SignalTurn[] {
  const runs = turns.filter((turn) => turn.lane === "runtime");
  if (runs.length === 0 || calls.length === 0) return [...turns];
  const assigned = assignModelCalls(runs, calls, runTraces);
  return turns.map((turn) => {
    const linked = assigned.get(turn.id);
    return linked && linked.length > 0 ? { ...turn, linked: linkedFactOf(linked) } : turn;
  });
}

/** A linked run's wall time: its own span widened to its model calls. */
export function linkedRunMs(
  turn: Pick<SignalTurn, "startedAt" | "endedAt">,
  fact: LinkedRunFact,
): number {
  const start = Math.min(turn.startedAt.getTime(), fact.firstAtMs);
  const end = Math.max(turn.endedAt.getTime(), fact.lastEndMs);
  return Math.max(0, end - start);
}
