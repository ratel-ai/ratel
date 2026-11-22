import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWatch, MIN_RUNS, type WatchFacts, type WatchShipment } from "./watch";

const SHIPMENT: WatchShipment = {
  id: "11111111-1111-4111-8111-111111111111",
  fixId: "craft:abc",
  fixKind: "enrich",
  fixTitle: "Return what lookup_reservation fetches in find_booking's response",
  version: "1.1.0",
  shippedAt: "2026-11-17T12:00:00.000Z",
  tools: ["find_booking", "lookup_reservation"],
};
const NOW = new Date("2026-11-17T12:05:00.000Z");

function facts(
  over: {
    runsAfter?: number;
    findAfter?: Partial<WatchFacts["after"]["tools"][number]>;
    lookupAfter?: number;
  } = {},
): WatchFacts {
  const runsAfter = over.runsAfter ?? 20;
  return {
    before: {
      tools: [
        { toolId: "find_booking", calls: 400, errors: 8, p50Ms: 480 },
        { toolId: "lookup_reservation", calls: 40, errors: 0, p50Ms: 470 },
      ],
      runs: { runs: 380, toolCalls: 380 * 3.4, tokens: 380 * 5_200 },
    },
    after: {
      tools: [
        { toolId: "find_booking", calls: runsAfter, errors: 0, p50Ms: 500, ...over.findAfter },
        { toolId: "lookup_reservation", calls: over.lookupAfter ?? 0, errors: 0, p50Ms: null },
      ],
      runs: { runs: runsAfter, toolCalls: runsAfter * 3.2, tokens: runsAfter * 4_900 },
    },
    traces: [
      {
        traceId: "t1",
        startedAt: "2026-11-17T12:04:00.000Z",
        tools: ["find_booking"],
        error: false,
      },
    ],
  };
}

test("an enrich fix watches its first tool and expects no call of the second", () => {
  const watch = buildWatch("p1", SHIPMENT, facts(), NOW);
  assert.deepEqual(
    watch.changed.map((tool) => tool.toolId),
    ["find_booking"],
  );
  assert.deepEqual(
    watch.removed.map((tool) => tool.toolId),
    ["lookup_reservation"],
  );
  assert.equal(watch.changed[0]!.baseline.errorRate, 0.02);
  assert.equal(watch.changed[0]!.after.p50Ms, 500);
  assert.equal(watch.removed[0]!.callsAfter, 0);
  assert.equal(watch.removed[0]!.baselineCalls, 40);
});

test("runs before and after: tool calls and tokens per run", () => {
  const watch = buildWatch("p1", SHIPMENT, facts(), NOW);
  assert.equal(watch.runs.before.runs, 380);
  assert.equal(watch.runs.before.toolCallsPerRun, 3.4);
  assert.equal(watch.runs.after.toolCallsPerRun, 3.2);
  assert.equal(watch.runs.after.tokensPerRun, 4_900);
  assert.deepEqual(watch.runs.tools, ["find_booking", "lookup_reservation"]);
});

test(`fewer than ${MIN_RUNS} runs since the ship: watching`, () => {
  const watch = buildWatch("p1", SHIPMENT, facts({ runsAfter: MIN_RUNS - 1 }), NOW);
  assert.equal(watch.verdict.status, "watching");
  assert.match(watch.verdict.reasons[0]!, new RegExp(`${MIN_RUNS - 1} of ${MIN_RUNS} runs`));
});

test("enough runs, no removed call, errors and latency in line: healthy", () => {
  const watch = buildWatch("p1", SHIPMENT, facts(), NOW);
  assert.equal(watch.verdict.status, "healthy");
});

test("a removed tool still called after the ship is a regression, even while watching", () => {
  const watch = buildWatch("p1", SHIPMENT, facts({ runsAfter: 2, lookupAfter: 3 }), NOW);
  assert.equal(watch.verdict.status, "regressed");
  assert.match(
    watch.verdict.reasons.join(" "),
    /lookup_reservation was called 3 times after the ship/,
  );
  assert.equal(watch.removed[0]!.flagged, true);
});

test("a changed tool failing clearly more than before is a regression", () => {
  const watch = buildWatch("p1", SHIPMENT, facts({ findAfter: { calls: 20, errors: 4 } }), NOW);
  assert.equal(watch.verdict.status, "regressed");
  assert.match(watch.verdict.reasons.join(" "), /find_booking fails 20% of calls, up from 2%/);
});

test("a changed tool clearly slower than before is a regression; a little slower is not", () => {
  assert.equal(
    buildWatch("p1", SHIPMENT, facts({ findAfter: { p50Ms: 900 } }), NOW).verdict.status,
    "regressed",
  );
  assert.equal(
    buildWatch("p1", SHIPMENT, facts({ findAfter: { p50Ms: 560 } }), NOW).verdict.status,
    "healthy",
  );
});

test("traces link to their trace page and say when they called a removed tool", () => {
  const input = facts();
  input.traces.push({
    traceId: "t2",
    startedAt: "2026-11-17T12:03:00.000Z",
    tools: ["find_booking", "lookup_reservation"],
    error: false,
  });
  const watch = buildWatch("p1", SHIPMENT, input, NOW);
  assert.equal(watch.traces[0]!.href, "/project/p1/traces/t1");
  assert.equal(watch.traces[1]!.calledRemoved, true);
  assert.equal(watch.traces[0]!.calledRemoved, false);
});
