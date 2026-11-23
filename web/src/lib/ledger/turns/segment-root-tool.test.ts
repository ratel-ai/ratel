import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TURN_CONFIG, type TurnConfig } from "@/lib/ledger/constants";
import { DEV_TRACE_SIGNALS_HASH_SALT } from "@/lib/ledger/hash";
import { asStoredTurn, fixtureId } from "@/lib/ledger/test-support";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import { OTLP_RUN_PREFIX } from "@/lib/ledger/turns/segment";
import type { TurnDraft, TurnEventRow } from "@/lib/ledger/types";

/**
 * Rule 4's fallback: an MCP server without propagated trace context exports
 * every `tools/call` as its own trace. Calls marked `rootTool` that carry a
 * session group into runs by quiet gap; without a session they stay one turn
 * per trace, as before.
 */

const CONFIG: TurnConfig = {
  ...DEFAULT_TURN_CONFIG,
  gapMs: 90_000,
  stepCap: 40,
  durationCapMs: 15 * 60_000,
};
const T0 = Date.parse("2026-09-30T12:00:00Z");

interface Call {
  tool: string;
  atMs: number;
  session?: string | null;
  rootTool?: boolean;
  trace?: string;
  error?: boolean;
}

function rows(calls: readonly Call[]): TurnEventRow[] {
  return calls.map((call, i) => {
    const trace = call.trace ?? `trace-${i}-${call.tool}`;
    return {
      id: fixtureId(),
      type: call.error ? "invoke_error" : "invoke_end",
      sessionId: call.session === null ? trace : (call.session ?? "mcp-session-1"),
      sourceId: "pm-server",
      ingestSource: "otlp",
      occurredAt: new Date(T0 + call.atMs),
      receivedAt: new Date(T0 + call.atMs + 200),
      turnId: null,
      invocationId: null,
      traceId: trace,
      toolId: call.tool,
      skillId: null,
      query: null,
      topK: null,
      hitCount: null,
      tookMs: 40,
      endUserId: null,
      ...(call.rootTool === false ? {} : { rootTool: true }),
    };
  });
}

function build(eventRows: readonly TurnEventRow[], stored: readonly TurnDraft[] = []): TurnDraft[] {
  const events = normalizeEvents(eventRows, new Map(), { salt: DEV_TRACE_SIGNALS_HASH_SALT });
  const now = new Date(T0 + 24 * 3_600_000);
  return buildTurns({ stored: stored.map((t) => asStoredTurn(t)), events, now, config: CONFIG })
    .turns;
}

const tools = (turn: TurnDraft) =>
  turn.steps.map((s) => `${s.targetId}${s.outcome === "error" ? "!" : ""}`);

test("a session's root-tool calls within the gap form one run", () => {
  const eventRows = rows([
    { tool: "search_tasks", atMs: 0 },
    { tool: "get_task", atMs: 2_000 },
    { tool: "assign_task", atMs: 5_000, error: true },
  ]);
  const turns = build(eventRows);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnKey, `${OTLP_RUN_PREFIX}${eventRows[0].id}`);
  assert.equal(turns[0].turnSource, "otlp");
  assert.equal(turns[0].lane, "otlp");
  assert.equal(turns[0].sessionId, "mcp-session-1");
  assert.deepEqual(tools(turns[0]), ["search_tasks", "get_task", "assign_task!"]);
  assert.equal(turns[0].errorCount, 1);
});

test("a quiet gap over the threshold starts the next run", () => {
  const turns = build(
    rows([
      { tool: "search_tasks", atMs: 0 },
      { tool: "get_task", atMs: 1_000 },
      { tool: "get_user", atMs: 1_000 + 90_001 },
      { tool: "list_tasks", atMs: 1_000 + 91_000 },
    ]),
  );
  assert.deepEqual(turns.map(tools), [
    ["search_tasks", "get_task"],
    ["get_user", "list_tasks"],
  ]);
  assert.deepEqual(
    turns.map((t) => t.endedBy),
    ["gap", "idle"],
  );
});

test("a run is capped like an inferred turn", () => {
  const calls = Array.from({ length: 45 }, (_, i) => ({ tool: `t${i}`, atMs: i * 1_000 }));
  assert.deepEqual(
    build(rows(calls)).map((t) => t.steps.length),
    [40, 5],
  );
});

test("without a session every root-tool call stays its own trace's turn", () => {
  const turns = build(
    rows([
      { tool: "search_tasks", atMs: 0, session: null },
      { tool: "get_task", atMs: 1_000, session: null },
    ]),
  );
  assert.deepEqual(
    turns.map((t) => t.turnKey),
    ["otlp:trace-0-search_tasks", "otlp:trace-1-get_task"],
  );
});

test("calls that share a trace keep grouping by trace beside a session's run", () => {
  const turns = build(
    rows([
      { tool: "search_tasks", atMs: 0 },
      { tool: "find_board", atMs: 500, rootTool: false, trace: "agent-trace" },
      { tool: "archive_board", atMs: 800, rootTool: false, trace: "agent-trace" },
      { tool: "get_task", atMs: 1_000 },
    ]),
  );
  const run = turns.find((t) => t.turnKey.startsWith(OTLP_RUN_PREFIX));
  const trace = turns.find((t) => t.turnKey === "otlp:agent-trace");
  assert.deepEqual(run && tools(run), ["search_tasks", "get_task"]);
  assert.deepEqual(trace && tools(trace), ["find_board", "archive_board"]);
});

test("building in two pages over the stored open run equals one full build", () => {
  const all = rows([
    { tool: "search_tasks", atMs: 0 },
    { tool: "get_task", atMs: 1_000 },
    { tool: "get_user", atMs: 2_000 },
    { tool: "list_tasks", atMs: 200_000 },
  ]);
  const full = build(all);
  const first = build(all.slice(0, 2));
  const second = build(all.slice(2), first);
  assert.deepEqual(
    second.map((t) => t.turnKey),
    full.map((t) => t.turnKey),
  );
  assert.deepEqual(second.map(tools), full.map(tools));
});
