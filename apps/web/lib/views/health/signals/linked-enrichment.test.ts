import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSetupFacts, type SetupCounts } from "@/lib/readings/trace-signals/setup-facts";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { addLinkedDays, linkedDayOf } from "@/lib/readings/trace-signals/signals/linked-day";
import { type LinkCandidate, linkedFactOf } from "@/lib/readings/trace-signals/signals/linked-runs";
import { emptyOtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts";
import {
  type DayBucket,
  emptyBucket,
  turnBucket,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { compactTurn } from "@/lib/readings/trace-signals/signals/workflow-run";
import { modelHealth } from "@/lib/readings/trace-signals/workflows/health";
import { hasLinkedRuns, linkedTilesFor } from "@/lib/views/health/signals/linked-metrics";
import { sourceReadings } from "@/lib/views/health/signals/page-view";
import { formatUsd, tileDelta, tileFigure } from "@/lib/views/health/tiles";

/**
 * What linking SDK runs to OpenTelemetry model calls adds, piece by piece:
 * the model-call signals on SDK runs, the band's cost and model-call tiles,
 * workflow cost and model time, and the setup row's link item. Without linked
 * runs every piece reads exactly as before.
 */

const AT = Date.parse("2026-09-01T09:00:00Z");

function modelCalls(n: number, over: Partial<LinkCandidate> = {}): LinkCandidate[] {
  return times(n, (i) => ({
    id: `m-${i}`,
    sessionId: "s",
    atMs: AT + i * 1_000,
    tookMs: 700,
    inputTokens: 2_000,
    outputTokens: 200,
    model: "claude-sonnet-4-6",
    prompt: i === 0 ? "plan next sprint" : null,
    menu: ["find_task", "assign_task", "archive_board"],
    ...over,
  }));
}

/** SDK runs calling find_task then assign_task, each linked to `calls(i)` model calls. */
function linkedRuns(n: number, calls: (i: number) => number): SignalTurn[] {
  return signalTurns(times(n, () => fresh().invoke("find_task").invoke("assign_task"))).map(
    (turn, i) => ({
      ...turn,
      linked: linkedFactOf(modelCalls(calls(i))),
    }),
  );
}

const withOtel = (turns: readonly SignalTurn[]) => contextFor(turns, { otel: emptyOtelFacts() });

test("linked SDK runs feed long_turn and unused_tool, never the OTLP tool-call kinds", () => {
  const turns = linkedRuns(60, (i) => (i < 12 ? 14 : 3));
  const result = analyzeTurns(turns, withOtel(turns));
  assert.ok(result.measured.has("long_turn"));
  assert.ok(result.measured.has("unused_tool"));
  assert.equal(result.measured.has("tool_switch"), false);
  assert.equal(result.measured.has("unknown_tool"), false);
  const long = result.signals.find((s) => s.kind === "long_turn");
  assert.equal(long?.metrics.k, 12);
  assert.equal(long?.lane, "runtime");
  const unused = result.signals.find((s) => s.kind === "unused_tool");
  assert.deepEqual(unused?.subjectIds, ["archive_board"]);
  assert.deepEqual(result.linking, { sdkRuns: 60, linkedRuns: 60 });
});

test("SDK runs without links measure no OTel kind, as before", () => {
  const turns = signalTurns(times(30, () => fresh().invoke("find_task")));
  const result = analyzeTurns(turns, withOtel(turns));
  assert.equal(
    [...result.measured].some((k) => ["long_turn", "unused_tool", "tool_switch"].includes(k)),
    false,
  );
  assert.equal(
    result.summary.daily.some((day) => "linked" in day),
    false,
  );
});

test("a linked run adds its cost and model calls to its day, and days add up", () => {
  const [turn] = linkedRuns(1, () => 4);
  const day = turnBucket(turn!).linked;
  const l = turn!.linked!;
  assert.deepEqual(day, {
    runs: 1,
    modelCalls: 4,
    pricedRuns: 1,
    costUsd: 0.036,
    modelMs: l.modelMs,
    inputTokens: l.inputTokens,
    outputTokens: l.outputTokens,
  });
  assert.deepEqual(
    addLinkedDays(
      day,
      linkedDayOf({
        modelCalls: 2,
        costUsd: null,
        modelMs: 500,
        inputTokens: 1_000,
        outputTokens: 50,
      }),
    ),
    {
      runs: 2,
      modelCalls: 6,
      pricedRuns: 1,
      costUsd: 0.036,
      modelMs: l.modelMs + 500,
      inputTokens: l.inputTokens + 1_000,
      outputTokens: l.outputTokens + 50,
    },
  );
  assert.equal(addLinkedDays(undefined, undefined), undefined);
});

function bucketWith(linked: DayBucket["linked"], day = "2026-09-01"): DayBucket {
  return { ...emptyBucket(day), turns: 100, ...(linked ? { linked } : {}) };
}

test("the band swaps detours and junk for cost and model calls per run when runs are linked", () => {
  const w = {
    end: new Date("2026-09-02T00:00:00Z"),
    days: 7,
    coveredFrom: "2026-08-01",
    floor: 50,
  };
  const daily = [bucketWith({ runs: 40, modelCalls: 160, pricedRuns: 40, costUsd: 1.2 })];
  const tiles = sourceReadings("mixed", daily, daily[0]!, w).tiles;
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["first_try", "wasted_calls", "cost_per_run", "model_calls"],
  );
  assert.equal(tiles[2]!.value, 0.03);
  assert.equal(tiles[3]!.value, 4);
  assert.deepEqual(
    linkedTilesFor(daily, w).map((t) => t.label),
    ["First try", "Wasted calls", "Cost per run", "Model calls per run"],
  );
  const plain = [bucketWith(undefined)];
  assert.equal(hasLinkedRuns(plain[0]!), false);
  assert.deepEqual(
    sourceReadings("mixed", plain, plain[0]!, w).tiles.map((t) => t.key),
    ["first_try", "detours", "junk", "wasted_calls"],
  );
});

test("dollar tiles print dollars", () => {
  assert.equal(formatUsd(0.03), "$0.03");
  assert.equal(formatUsd(0.0042), "$0.004");
  assert.equal(formatUsd(1.2), "$1.20");
  assert.equal(formatUsd(0.0004), "<$0.001");
  assert.deepEqual(tileFigure({ value: 0.031, unit: "usd" }), {
    value: "$0.03",
    unit: null,
    ready: true,
  });
  assert.equal(
    tileDelta({ value: 0.03, delta: 0.004, unit: "usd", upIsGood: false })?.text,
    "+$0.004",
  );
  assert.equal(tileDelta({ value: 0.03, delta: 0.004, unit: "usd", upIsGood: false })?.tone, "bad");
});

test("a workflow's model figures come from its linked runs only", () => {
  const turns = [
    ...linkedRuns(3, (i) => 2 + i),
    ...signalTurns([fresh().invoke("find_task").invoke("assign_task")]),
  ];
  const compact = turns.map((t) => compactTurn(t)!);
  assert.equal("model" in compact[3]!, false, "an unlinked run carries no model field");
  const model = modelHealth(compact);
  assert.equal(model?.runs, 3);
  assert.equal(model?.medianModelCalls, 3);
  assert.equal(model?.medianCostUsd, 0.027);
  assert.ok(model!.modelShare > 0 && model!.modelShare <= 1);
  assert.equal(modelHealth(compact.slice(3)), null);
});

const COUNTS: SetupCounts = {
  otel: {
    toolRows: 10,
    toolRowsWithSession: 10,
    toolRowsWithUser: 10,
    toolRowsWithResult: 10,
    modelCalls: 40,
    modelCallsWithPrompt: 40,
    modelCallsWithMenu: 40,
  },
  sdk: {
    searches: 10,
    searchesWithQuery: 10,
    turns: 20,
    declaredTurns: 20,
    turnsWithTools: 20,
    userMessages: 0,
    events: 50,
    eventsWithUser: 50,
  },
};

test("a project sending both gets the link item, with the share of SDK runs linked", () => {
  const setup = buildSetupFacts(COUNTS, { sdkRuns: 20, linkedRuns: 12 });
  assert.deepEqual(
    setup.facts.find((f) => f.key === "both_linked"),
    { key: "both_linked", status: "partial", share: 0.6 },
  );
  assert.equal(buildSetupFacts(COUNTS, { sdkRuns: 20, linkedRuns: 0 }).facts.at(-1)?.status, "off");
  assert.equal(
    buildSetupFacts(COUNTS).facts.some((f) => f.key === "both_linked"),
    false,
  );
  const sdkOnly = { ...COUNTS, otel: { ...COUNTS.otel, toolRows: 0, modelCalls: 0 } };
  assert.equal(
    buildSetupFacts(sdkOnly, { sdkRuns: 20, linkedRuns: 0 }).facts.some(
      (f) => f.key === "both_linked",
    ),
    false,
  );
});
