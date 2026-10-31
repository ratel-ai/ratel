import { type TurnFixture, turn } from "@/lib/ledger/test-support";
import {
  buildOtelFacts,
  OTLP_MODEL_CALL_TYPE,
  type OtelFactRow,
  type OtelFacts,
} from "@/lib/readings/trace-signals/signals/otel-facts";
import { signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Test helpers for the OTel signals: an OTLP-lane turn is one trace whose tool
 * calls arrive as lone `invoke_end` / `invoke_error` rows (as
 * `lib/otlp/derive-tools.ts` writes them), plus the `trace_events` rows OTLP
 * ingest records beside the ledger, folded into {@link OtelFacts}.
 *
 *   const world = otelWorld([
 *     ...times(12, () => trace([call("a", { error: "timeout" }), call("b")], { modelCalls: 3 })),
 *   ]);
 *   analyzeTurns(world.turns, contextFor(world.turns, { otel: world.facts }));
 */

export interface OtelCall {
  tool: string;
  /** The error type; the call fails. */
  error?: string;
  /** The captured result was empty (true) or not (false); omitted when not captured. */
  empty?: boolean;
  /** The captured arguments' hash; omitted when not captured. */
  args?: string;
  /** How long the call took. */
  tookMs?: number;
  /** The agent that made the call. */
  agent?: string;
}

export interface OtelTraceSpec {
  calls: readonly OtelCall[];
  modelCalls?: number;
  /** Tool names offered on every model call of the trace. */
  menu?: readonly string[];
  inputTokens?: number;
  /** Sessions span traces when set; else each trace is its own session. */
  session?: string;
  /** Time between the trace's calls, so a turn's wall time can be set. */
  stepMs?: number;
  /** Who started the turn, as its model calls' captured prompt says. */
  startedBy?: "system" | "person";
}

export function call(tool: string, opts: Omit<OtelCall, "tool"> = {}): OtelCall {
  return { tool, ...opts };
}

export function trace(
  calls: readonly OtelCall[],
  opts: Omit<OtelTraceSpec, "calls"> = {},
): OtelTraceSpec {
  return { calls, ...opts };
}

export interface OtelWorld {
  turns: SignalTurn[];
  rows: OtelFactRow[];
  facts: OtelFacts;
}

let traceCounter = 0;

function fixtureOf(spec: OtelTraceSpec, traceId: string): TurnFixture {
  const fixture = turn({
    lane: "otlp",
    traceId,
    session: spec.session ?? traceId,
    ...(spec.stepMs ? { stepMs: spec.stepMs } : {}),
  });
  for (const c of spec.calls) {
    const opts = c.tookMs !== undefined ? { tookMs: c.tookMs } : {};
    if (c.error) fixture.error(c.tool, opts);
    else fixture.end(c.tool, opts);
  }
  return fixture;
}

function stepRows(spec: OtelTraceSpec, t: SignalTurn): OtelFactRow[] {
  const invokes = t.steps.filter((step) => step.kind === "invoke");
  return spec.calls.flatMap((c, i): OtelFactRow[] => {
    const step = invokes[i];
    if (
      !step ||
      (!c.error && c.empty === undefined && c.args === undefined && c.agent === undefined)
    )
      return [];
    return [
      {
        id: step.traceEventId,
        type: c.error ? "invoke_error" : "invoke_end",
        traceId: t.turnKey?.slice("otlp:".length) ?? null,
        errorType: c.error ?? null,
        resultEmpty: c.error ? null : (c.empty ?? null),
        argHash: c.args ?? null,
        agent: c.agent ?? null,
        inputTokens: null,
        outputTokens: null,
        menu: null,
      },
    ];
  });
}

function modelRows(spec: OtelTraceSpec, traceId: string): OtelFactRow[] {
  const n = spec.modelCalls ?? 0;
  return Array.from({ length: n }, (_, i) => ({
    id: `${traceId}:model:${i}`,
    type: OTLP_MODEL_CALL_TYPE,
    traceId,
    errorType: null,
    resultEmpty: null,
    argHash: null,
    inputTokens: Math.round((spec.inputTokens ?? 0) / n),
    outputTokens: 10,
    menu: spec.menu ? [...spec.menu] : null,
    startedBy: spec.startedBy ?? null,
  }));
}

/** OTLP-lane turns for the specs, in order, with the facts ingest would record for them. */
export function otelWorld(specs: readonly OtelTraceSpec[]): OtelWorld {
  const ids = specs.map(() => `trace-${(++traceCounter).toString().padStart(6, "0")}`);
  const turns = signalTurns(specs.map((spec, i) => fixtureOf(spec, ids[i]!)));
  const byKey = new Map(turns.map((t) => [t.turnKey, t] as const));
  const rows = specs.flatMap((spec, i) => {
    const t = byKey.get(`otlp:${ids[i]}`);
    return [...(t ? stepRows(spec, t) : []), ...modelRows(spec, ids[i]!)];
  });
  return { turns, rows, facts: buildOtelFacts(rows) };
}
