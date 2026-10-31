import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * What OpenTelemetry tells a signal run beyond the turn ledger's steps.
 *
 * OTLP ingest (`lib/otlp/derive-tools.ts`, `derive-model-calls.ts`) writes two
 * kinds of rows for projects with Agent health on: one `invoke_end` /
 * `invoke_error` per tool-call span (these become ledger steps), and one
 * `otlp_model_call` per model round trip (never a step). The step rows carry a
 * few facts the ledger has no column for (the error type, whether a captured
 * result was empty, an argument hash); the model-call rows carry the round
 * trips, tokens and, when captured, the tool menu. This module folds both into
 * {@link OtelFacts}, keyed the way the detectors look them up: by the step's
 * `trace_events` id, and by the turn's trace id (an OTLP-lane turn is one trace,
 * `turn_key = otlp:<traceId>`).
 *
 * Pure: the read lives in `otel-facts-query.ts`. Names only, never content.
 */

/** Facts of one OTLP-derived tool call, by its `trace_events` id. */
export interface OtelStepFact {
  errorType: string | null;
  /** Null when the customer does not capture results. */
  resultEmpty: boolean | null;
  /** Null when the customer does not capture arguments. */
  argHash: string | null;
  /** The agent or subagent that made the call, when the spans name it. */
  agent: string | null;
}

/** Model round trips of one trace. */
export interface OtelTraceFact {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Union of the tool names offered across the trace's model calls. */
  menus: Set<string>;
  /** Model calls that carried a captured tool menu. */
  menuCalls: number;
  /**
   * Who started the turn, from its first model call's captured prompt: a
   * system (a background task reporting back, a subagent's brief) or a
   * person. Null when no prompt was captured.
   */
  startedBy?: StartedBy | null;
}

export type StartedBy = "system" | "person";

export interface OtelFacts {
  stepFacts: Map<string, OtelStepFact>;
  traces: Map<string, OtelTraceFact>;
}

/** One OTLP-derived `trace_events` row, as much of it as the facts need. */
export interface OtelFactRow {
  id: string;
  type: string;
  traceId: string | null;
  errorType: string | null;
  resultEmpty: boolean | null;
  argHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The tool names offered on a model call, when captured. */
  menu: readonly string[] | null;
  /** On a tool call: the agent that made it. Optional, so older callers need not set it. */
  agent?: string | null;
  /** On a model call: who started its turn, when its prompt was captured. */
  startedBy?: StartedBy | null;
}

export const OTLP_MODEL_CALL_TYPE = "otlp_model_call";
export const OTEL_FACT_TYPES = ["invoke_end", "invoke_error", OTLP_MODEL_CALL_TYPE] as const;
const OTLP_TURN_KEY_PREFIX = "otlp:";

export function emptyOtelFacts(): OtelFacts {
  return { stepFacts: new Map(), traces: new Map() };
}

/**
 * A streaming builder, so the read can page rows in without holding them.
 * Menu names repeat across thousands of model calls, so each distinct name is
 * kept once (interned) rather than once per trace.
 */
export interface OtelFactsBuilder {
  add(row: OtelFactRow): void;
  finish(): OtelFacts;
}

export function createOtelFactsBuilder(): OtelFactsBuilder {
  const facts = emptyOtelFacts();
  const interned = new Map<string, string>();
  const intern = (name: string): string => {
    const known = interned.get(name);
    if (known !== undefined) return known;
    interned.set(name, name);
    return name;
  };
  return {
    add(row) {
      if (row.type === OTLP_MODEL_CALL_TYPE) addModelCall(facts, row, intern);
      else addStepFact(facts, row);
    },
    finish() {
      return facts;
    },
  };
}

function addStepFact(facts: OtelFacts, row: OtelFactRow): void {
  const errorType = row.type === "invoke_error" ? (row.errorType ?? "error") : null;
  const agent = row.agent ?? null;
  if (errorType === null && row.resultEmpty === null && row.argHash === null && agent === null)
    return;
  facts.stepFacts.set(row.id, {
    errorType,
    resultEmpty: row.resultEmpty,
    argHash: row.argHash,
    agent,
  });
}

function addModelCall(facts: OtelFacts, row: OtelFactRow, intern: (name: string) => string): void {
  if (!row.traceId) return;
  const trace = facts.traces.get(row.traceId) ?? {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    menus: new Set<string>(),
    menuCalls: 0,
    startedBy: null,
  };
  // Rows arrive in time order: the first call that captured a prompt says who started the turn.
  if (!trace.startedBy && row.startedBy) trace.startedBy = row.startedBy;
  trace.modelCalls += 1;
  trace.inputTokens += row.inputTokens ?? 0;
  trace.outputTokens += row.outputTokens ?? 0;
  const menu = (row.menu ?? []).filter((name) => typeof name === "string" && name.length > 0);
  if (menu.length > 0) {
    trace.menuCalls += 1;
    for (const name of menu) trace.menus.add(intern(name));
  }
  facts.traces.set(row.traceId, trace);
}

/** Folds rows into facts; the pure path tests use. */
export function buildOtelFacts(rows: Iterable<OtelFactRow>): OtelFacts {
  const builder = createOtelFactsBuilder();
  for (const row of rows) builder.add(row);
  return builder.finish();
}

/**
 * The trace an OTLP-lane turn covers, read from its `otlp:<traceId>` key; null
 * otherwise, as for an `otlp-run:` turn (several one-call traces of a session).
 */
export function otelTraceIdOf(turn: Pick<SignalTurn, "lane" | "turnKey">): string | null {
  if (turn.lane !== "otlp" || !turn.turnKey?.startsWith(OTLP_TURN_KEY_PREFIX)) return null;
  const id = turn.turnKey.slice(OTLP_TURN_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}
