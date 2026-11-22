import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_RUN_EVENT_TYPE } from "@/lib/ledger/constants";
import { DEV_TRACE_SIGNALS_HASH_SALT } from "@/lib/ledger/hash";
import { asStoredTurn, fixtureId } from "@/lib/ledger/test-support";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type { TurnDraft, TurnEventRow } from "@/lib/ledger/types";

/**
 * RC-742: an `agent_run` row (an `invoke_agent` root span) makes an OTLP turn
 * on its own, keyed by its trace like every OTLP turn. Its step is an `agent`
 * step: not a search, not a tool call, so no tool fact or shape counts it.
 */

const T0 = Date.parse("2026-11-17T10:00:00Z");
const TRACE = "a".repeat(32);

function row(type: string, overrides: Partial<TurnEventRow> = {}): TurnEventRow {
  return {
    id: fixtureId(),
    type,
    sessionId: "job-1",
    sourceId: "ratel-cloud",
    ingestSource: "otlp",
    occurredAt: new Date(T0),
    receivedAt: new Date(T0 + 5_000),
    turnId: null,
    invocationId: null,
    traceId: TRACE,
    toolId: null,
    skillId: null,
    query: null,
    topK: null,
    hitCount: null,
    tookMs: 4_000,
    endUserId: null,
    ...overrides,
  };
}

function build(
  rows: readonly TurnEventRow[],
  stored: readonly TurnDraft[] = [],
  now = new Date(T0 + 24 * 3_600_000),
): TurnDraft[] {
  const events = normalizeEvents(rows, new Map(), { salt: DEV_TRACE_SIGNALS_HASH_SALT });
  return buildTurns({ stored: stored.map((t) => asStoredTurn(t)), events, now }).turns;
}

/** One minute after the rows were received: well inside the idle window. */
const SOON = new Date(T0 + 65_000);

test("an agent_run row alone makes exactly one closed otlp turn with one agent step", () => {
  const turns = build([row(AGENT_RUN_EVENT_TYPE)]);
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.turnKey, `otlp:${TRACE}`);
  assert.equal(turn.turnSource, "otlp");
  assert.equal(turn.lane, "otlp");
  assert.equal(turn.status, "closed");
  assert.equal(turn.steps.length, 1);
  assert.equal(turn.steps[0]!.kind, "agent");
  assert.equal(turn.steps[0]!.eventType, AGENT_RUN_EVENT_TYPE);
  assert.equal(turn.steps[0]!.outcome, "ok");
  assert.equal(turn.steps[0]!.tookMs, 4_000);
  assert.equal(turn.invokeCount, 0);
  assert.equal(turn.searchCount, 0);
  assert.equal(turn.distinctTools, 0);
  assert.equal(turn.errorCount, 0);
  assert.equal(turn.firstTry, null);
});

test("a failed run's agent step reads error, counts no tool error, and keeps it on rebuild", () => {
  const first = build([row(AGENT_RUN_EVENT_TYPE, { failed: true })]);
  assert.equal(first[0]!.steps[0]!.outcome, "error");
  assert.equal(first[0]!.errorCount, 0);
  assert.deepEqual(build([], first), first);
});

test("tool calls of the same trace join the agent run's turn: still one turn", () => {
  const turns = build([
    row(AGENT_RUN_EVENT_TYPE),
    row("invoke_end", { toolId: "search_docs", occurredAt: new Date(T0 + 1_000), tookMs: 40 }),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0]!.steps.map((s) => s.kind),
    ["agent", "invoke"],
  );
  assert.equal(turns[0]!.invokeCount, 1);
});

test("rebuilt from its stored steps, the turn is the same (idempotent)", () => {
  const first = build([row(AGENT_RUN_EVENT_TYPE)]);
  const again = build([], first);
  assert.deepEqual(again, first);
});

test("an agent_run row on the runtime lane is not read", () => {
  assert.deepEqual(build([row(AGENT_RUN_EVENT_TYPE, { ingestSource: "runtime" })]), []);
});

test("the agent's name rides the agent step as its target id, no target type, and survives a rebuild (RC-747)", () => {
  const first = build([row(AGENT_RUN_EVENT_TYPE, { agent: "draft_fix" })]);
  const step = first[0]!.steps[0]!;
  assert.equal(step.targetId, "draft_fix");
  assert.equal(step.targetType, null);
  assert.equal(first[0]!.distinctTools, 0, "an agent is not a tool");
  assert.deepEqual(build([], first), first);
  assert.equal(
    build([row(AGENT_RUN_EVENT_TYPE)])[0]!.steps[0]!.targetId,
    null,
    "a run without a name keeps none",
  );
});

test("a run is finished when its row exists: its turn closes at once and ends when the root span ended (RC-812)", () => {
  const first = build([row(AGENT_RUN_EVENT_TYPE)], [], SOON);
  const turn = first[0]!;
  assert.equal(turn.status, "closed");
  assert.equal(turn.endedBy, "idle");
  assert.equal(turn.startedAt.getTime(), T0);
  assert.equal(turn.endedAt.getTime(), T0 + 4_000, "start plus the root span's duration");
  assert.deepEqual(build([], first, SOON), first, "idempotent");
});

test("a tool call that arrives after the run's row joins the closed turn, which stays closed (RC-812)", () => {
  const first = build([row(AGENT_RUN_EVENT_TYPE)], [], SOON);
  const late = row("invoke_end", {
    toolId: "search_docs",
    occurredAt: new Date(T0 + 1_000),
    receivedAt: new Date(T0 + 9_000),
    tookMs: 40,
  });
  const turns = build([late], first, SOON);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0]!.steps.map((s) => s.kind),
    ["agent", "invoke"],
  );
  assert.equal(turns[0]!.status, "closed");
  assert.equal(turns[0]!.endedAt.getTime(), T0 + 4_000);
});

test("a run with no duration ends at its last event; a turn with no agent run still waits for the idle window (RC-812)", () => {
  const bare = build([row(AGENT_RUN_EVENT_TYPE, { tookMs: null })], [], SOON)[0]!;
  assert.equal(bare.status, "closed");
  assert.equal(bare.endedAt.getTime(), T0);

  const toolOnly = build([row("invoke_end", { toolId: "search_docs", tookMs: 40 })], [], SOON)[0]!;
  assert.equal(toolOnly.status, "open");
  assert.equal(toolOnly.endedBy, null);
  assert.equal(toolOnly.endedAt.getTime(), T0);
});
