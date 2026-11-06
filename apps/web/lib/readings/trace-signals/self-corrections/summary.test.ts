import assert from "node:assert/strict";
import { test } from "node:test";
import { turn } from "@/lib/ledger/test-support";
import {
  readTurns,
  type SelfCorrection,
  type SelfCorrectionKind,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import {
  type SelfCorrectionReading,
  summarizeSelfCorrections,
} from "@/lib/readings/trace-signals/self-corrections/summary";
import { wilson } from "@/lib/readings/trace-signals/signals/severity";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";

function ev(
  kind: SelfCorrectionKind,
  ordinal: number,
  tool: string | null,
  toolOrdinal: number | null,
  recovered: boolean | null = null,
): SelfCorrection {
  return {
    kind,
    ordinal,
    tool,
    toolOrdinal,
    toolOutcome: tool === null ? null : kind === "searched_again" ? "ok" : "error",
    recovered,
  };
}

const zeroKinds = {
  retry_after_error: 0,
  switch_after_error: 0,
  gave_up_after_error: 0,
  searched_again: 0,
  asked_again: 0,
};

test("nothing read: zeros, and every share is unknown", () => {
  const empty = { k: 0, n: 0, share: null, interval: null };
  assert.deepEqual(summarizeSelfCorrections([]), {
    turns: 0,
    events: 0,
    per100Turns: null,
    turnsWithEvents: empty,
    byKind: zeroKinds,
    byTool: [],
    withoutTool: 0,
    byWorkflow: [],
    unplacedTurns: 0,
    errors: { failedCalls: 0, recovered: empty, askedAgain: empty },
    askedAgain: empty,
  });
  assert.equal(
    summarizeSelfCorrections([null, undefined]).turns,
    0,
    "turns the trust left out are not counted",
  );
});

/** Four read turns and one left out. */
const READINGS: readonly (SelfCorrectionReading | null)[] = [
  {
    // One failure of a: switched away, then retried. Recovered, and the user did not ask again.
    events: [ev("switch_after_error", 2, "a", 1, true), ev("retry_after_error", 3, "a", 1, true)],
    askedAgain: false,
    workflowId: "w1",
  },
  {
    // The run gave up on b and the user asked again.
    events: [ev("gave_up_after_error", 2, "b", 2, false), ev("asked_again", 3, "b", 2)],
    askedAgain: true,
    workflowId: "w1",
  },
  { events: [ev("searched_again", 2, null, null)], askedAgain: null, workflowId: "w2" },
  { events: [], askedAgain: false },
  null,
];

test("rate per 100 turns, counts by kind, and the share of turns with a self-correction", () => {
  const summary = summarizeSelfCorrections(READINGS);
  assert.equal(summary.turns, 4);
  assert.equal(summary.events, 5);
  assert.equal(summary.per100Turns, 125);
  assert.deepEqual(summary.turnsWithEvents, { k: 3, n: 4, share: 0.75, interval: wilson(3, 4) });
  assert.deepEqual(summary.byKind, {
    retry_after_error: 1,
    switch_after_error: 1,
    gave_up_after_error: 1,
    searched_again: 1,
    asked_again: 1,
  });
});

test("by tool: the call before each event, most events first, ties by id", () => {
  const summary = summarizeSelfCorrections(READINGS);
  assert.deepEqual(summary.byTool, [
    { tool: "a", events: 2, byKind: { ...zeroKinds, retry_after_error: 1, switch_after_error: 1 } },
    { tool: "b", events: 2, byKind: { ...zeroKinds, gave_up_after_error: 1, asked_again: 1 } },
  ]);
  assert.equal(summary.withoutTool, 1, "a repeated search with no call before it");
});

test("by workflow, when the caller supplies one; the rest are unplaced", () => {
  const summary = summarizeSelfCorrections(READINGS);
  assert.deepEqual(summary.byWorkflow, [
    {
      workflowId: "w1",
      turns: 2,
      events: 4,
      per100Turns: 200,
      turnsWithEvents: { k: 2, n: 2, share: 1, interval: wilson(2, 2) },
      byKind: {
        ...zeroKinds,
        retry_after_error: 1,
        switch_after_error: 1,
        gave_up_after_error: 1,
        asked_again: 1,
      },
    },
    {
      workflowId: "w2",
      turns: 1,
      events: 1,
      per100Turns: 100,
      turnsWithEvents: { k: 1, n: 1, share: 1, interval: wilson(1, 1) },
      byKind: { ...zeroKinds, searched_again: 1 },
    },
  ]);
  assert.equal(summary.unplacedTurns, 1);
  assert.deepEqual(
    summarizeSelfCorrections(READINGS.map((r) => (r ? { ...r, workflowId: null } : r))).byWorkflow,
    [],
  );
});

test("errors count failed calls once: recovered, and followed by the user asking again", () => {
  const { errors } = summarizeSelfCorrections(READINGS);
  assert.equal(errors.failedCalls, 2, "a switch and a retry of one failure are one failed call");
  assert.deepEqual(errors.recovered, { k: 1, n: 2, share: 0.5, interval: wilson(1, 2) });
  assert.deepEqual(errors.askedAgain, { k: 1, n: 2, share: 0.5, interval: wilson(1, 2) });
});

test("asking again is a share of the turns where it can be told", () => {
  const { askedAgain } = summarizeSelfCorrections(READINGS);
  assert.deepEqual(askedAgain, { k: 1, n: 3, share: 1 / 3, interval: wilson(1, 3) });
  const untold = summarizeSelfCorrections([
    { events: [ev("gave_up_after_error", 1, "a", 1, false)], askedAgain: null },
  ]);
  assert.deepEqual(
    untold.errors.askedAgain,
    { k: 0, n: 0, share: null, interval: null },
    "a failure in a turn that cannot tell is left out",
  );
  assert.equal(untold.errors.failedCalls, 1);
});

test("end to end: fixture turns through readTurns into the summary", () => {
  const a = fresh({ endUser: "u1" })
    .search(["a", "b"], { query: "q" })
    .invoke("a")
    .error("a")
    .invoke("a");
  const b = turn({ after: a, gapMs: 120_000 })
    .search(["a", "b"], { query: "q" })
    .invoke("b")
    .error("b");
  const turns = signalTurns([a, b]);
  const readings = readTurns(turns, { runs: "all", sessions: true });
  const summary = summarizeSelfCorrections(
    readings.map((r) => (r ? { ...r, workflowId: "w" } : r)),
  );
  assert.equal(summary.turns, 2);
  assert.deepEqual(summary.byKind, {
    ...zeroKinds,
    retry_after_error: 1,
    gave_up_after_error: 1,
    asked_again: 1,
  });
  assert.deepEqual(summary.errors.recovered, { k: 1, n: 2, share: 0.5, interval: wilson(1, 2) });
  assert.deepEqual(
    summary.errors.askedAgain,
    { k: 1, n: 2, share: 0.5, interval: wilson(1, 2) },
    "the first turn's failure was asked about again",
  );
  assert.deepEqual(summary.askedAgain, { k: 1, n: 2, share: 0.5, interval: wilson(1, 2) });
  assert.equal(summary.byWorkflow[0]?.events, 3);
});
