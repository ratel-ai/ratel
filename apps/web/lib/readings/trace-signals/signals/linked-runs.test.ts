import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignModelCalls,
  type LinkCandidate,
  type LinkTurn,
  linkedFactOf,
  linkedRunMs,
  linkTurns,
} from "@/lib/readings/trace-signals/signals/linked-runs";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

const T0 = Date.UTC(2026, 8, 30, 9);

function run(id: string, sessionId: string, startS: number, endS: number): LinkTurn {
  return {
    id,
    sessionId,
    startedAt: new Date(T0 + startS * 1_000),
    endedAt: new Date(T0 + endS * 1_000),
  };
}

function call(
  id: string,
  sessionId: string,
  atS: number,
  over: Partial<LinkCandidate> = {},
): LinkCandidate {
  return {
    id,
    sessionId,
    atMs: T0 + atS * 1_000,
    tookMs: 1_000,
    inputTokens: 1_000,
    outputTokens: 100,
    model: "claude-sonnet-4-6",
    prompt: null,
    menu: null,
    ...over,
  };
}

const ids = (map: Map<string, LinkCandidate[]>, turnId: string) =>
  (map.get(turnId) ?? []).map((c) => c.id);

test("a model call links to the run of its session when it starts within 5 s of the run", () => {
  const assigned = assignModelCalls(
    [run("r1", "s-1", 10, 20)],
    [
      call("before", "s-1", 6),
      call("inside", "s-1", 15),
      call("after", "s-1", 24),
      call("early", "s-1", 4),
      call("late", "s-1", 40),
    ],
  );
  assert.deepEqual(ids(assigned, "r1"), ["before", "inside", "after"]);
});

test("another session's model calls never link, whatever the time", () => {
  const assigned = assignModelCalls([run("r1", "s-1", 10, 20)], [call("other", "s-2", 15)]);
  assert.equal(assigned.size, 0);
});

test("the model still working after the run keeps linking, until the session's next run starts", () => {
  const assigned = assignModelCalls(
    [run("r1", "s-1", 10, 20), run("r2", "s-1", 60, 70)],
    [
      call("tail", "s-1", 24, { tookMs: 4_000 }),
      call("chain-1", "s-1", 30),
      call("chain-2", "s-1", 34),
      call("gap", "s-1", 45),
    ],
  );
  assert.deepEqual(
    ids(assigned, "r1"),
    ["tail", "chain-1", "chain-2"],
    "a 10 s silence breaks the chain",
  );
  assert.deepEqual(ids(assigned, "r2"), []);
});

test("a call between two close runs joins the nearer one, once", () => {
  const assigned = assignModelCalls(
    [run("r1", "s-1", 10, 20), run("r2", "s-1", 23, 30)],
    [call("between", "s-1", 22)],
  );
  assert.deepEqual(ids(assigned, "r1"), []);
  assert.deepEqual(ids(assigned, "r2"), ["between"]);
});

test("a linked run's facts: calls, tokens, cost priced by model, model time, first prompt, menu", () => {
  const fact = linkedFactOf([
    call("b", "s-1", 12, { prompt: "close out release 4.2", menu: ["find_pr", "update_status"] }),
    call("a", "s-1", 10, { menu: ["find_pr"] }),
    call("c", "s-1", 14, { model: "unknown-model" }),
  ]);
  assert.equal(fact.modelCalls, 3);
  assert.equal(fact.inputTokens, 3_000);
  assert.equal(fact.outputTokens, 300);
  // Two priced calls of claude-sonnet-4-6: 1,000 in at $3/M and 100 out at $15/M each.
  assert.equal(fact.costUsd, 0.009);
  assert.equal(fact.modelMs, 3_000);
  assert.equal(fact.prompt, "close out release 4.2");
  assert.deepEqual([...fact.menus].sort(), ["find_pr", "update_status"]);
  assert.equal(fact.menuCalls, 2);
  assert.equal(fact.firstAtMs, T0 + 10_000);
  assert.equal(fact.lastEndMs, T0 + 15_000);
});

test("an unpriced model leaves the cost unknown, not zero", () => {
  assert.equal(linkedFactOf([call("a", "s-1", 10, { model: null })]).costUsd, null);
});

test("a linked run's wall time widens to its model calls", () => {
  const fact = linkedFactOf([call("a", "s-1", 7), call("b", "s-1", 22, { tookMs: 3_000 })]);
  assert.equal(linkedRunMs(run("r1", "s-1", 10, 20), fact), 18_000);
});

test("linkTurns adds `linked` to runtime runs only, and leaves every other turn as it was", () => {
  const sdk = {
    ...run("r1", "s-1", 10, 20),
    lane: "runtime",
    turnSource: "declared",
    steps: [],
  } as unknown as SignalTurn;
  const bare = {
    ...run("r2", "s-9", 10, 20),
    lane: "runtime",
    turnSource: "inferred",
    steps: [],
  } as unknown as SignalTurn;
  const otel = {
    ...run("o1", "s-1", 10, 20),
    lane: "otlp",
    turnSource: "otlp",
    steps: [],
  } as unknown as SignalTurn;
  const out = linkTurns([sdk, bare, otel], [call("a", "s-1", 12)]);
  assert.equal(out[0]!.linked?.modelCalls, 1);
  assert.equal(out[1], bare);
  assert.equal(out[2], otel);
  assert.equal("linked" in out[2]!, false);
});

test("a model call of a trace the run's SDK events carried links to it, whatever its session", () => {
  const assigned = assignModelCalls(
    [run("r1", "sdk-1", 10, 20), run("r2", "sdk-1", 200, 210)],
    [
      call("by-trace", "0123abcd", 15, { traceId: "trace-1" }),
      call("by-trace-late", "0123abcd", 150, { traceId: "trace-1" }),
      call("by-session", "sdk-1", 205),
      call("stranger", "0123abcd", 16, { traceId: "trace-9" }),
    ],
    new Map([["r1", new Set(["trace-1"])]]),
  );
  assert.deepEqual(ids(assigned, "r1"), ["by-trace", "by-trace-late"]);
  assert.deepEqual(ids(assigned, "r2"), ["by-session"]);
});

test("a trace two runs carried goes to the nearer run", () => {
  const assigned = assignModelCalls(
    [run("r1", "s-1", 10, 20), run("r2", "s-1", 100, 110)],
    [call("near-2", "x", 104, { traceId: "t" })],
    new Map([
      ["r1", new Set(["t"])],
      ["r2", new Set(["t"])],
    ]),
  );
  assert.deepEqual(ids(assigned, "r2"), ["near-2"]);
});

test("a call linked by trace keeps the run's chain going for the session's later calls", () => {
  const assigned = assignModelCalls(
    [run("r1", "s-1", 10, 20)],
    [call("traced", "x", 24, { traceId: "t", tookMs: 4_000 }), call("chained", "s-1", 30)],
    new Map([["r1", new Set(["t"])]]),
  );
  assert.deepEqual(ids(assigned, "r1"), ["traced", "chained"]);
});
