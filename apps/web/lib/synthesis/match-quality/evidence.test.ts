import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import type { QualitySelectionDiagnostics } from "@/lib/synthesis/quality/queries";
import {
  declineReason,
  freezeEvidence,
  MIN_CAPTURED_QUERIES,
  MIN_EVALUABLE_SEARCHES,
  observeRetrieval,
  pickTunedArm,
} from "./evidence";
import type { RunCensus } from "./types";

const BASE_AT = new Date("2026-09-10T12:00:00Z");

function diagnostics(
  overrides: Partial<QualitySelectionDiagnostics> = {},
): QualitySelectionDiagnostics {
  return {
    comparisonCount: 0,
    selectionCount: 0,
    invocationCount: 0,
    recordedRankCount: 0,
    attributionMode: "none",
    rankedSelectionCount: 0,
    invokedToolKey: null,
    truncated: false,
    ...overrides,
  };
}

function selection(
  id: string,
  opts: {
    invokedToolId?: string | null;
    query?: string | null;
    ratel?: string[];
    legacy?: string[];
    minutesAgo?: number;
  } = {},
): EvaluableSelection {
  return {
    selectionId: id,
    occurredAt: new Date(BASE_AT.getTime() - (opts.minutesAgo ?? 0) * 60_000),
    query: opts.query === undefined ? `query ${id}` : opts.query,
    invokedToolId: opts.invokedToolId ?? null,
    invokedRank: null,
    arms: [
      { arm: "ratel", role: "serving", resultIds: opts.ratel ?? ["a", "b"], resultScores: null },
      { arm: "legacy", role: "shadow", resultIds: opts.legacy ?? ["b"], resultScores: null },
    ],
  };
}

test("the baseline is chosen by name, so the serving arm is never the incumbent", () => {
  // Mirrors Acme production: ratel serves, legacy shadows.
  const { census } = freezeEvidence([selection("s1")], diagnostics());
  assert.equal(census.baselineArm, "legacy");
  assert.equal(census.servingArm, "ratel");
});

test("the tuned arm is ours by exclusion, whichever side happens to serve", () => {
  // Acme production: Ratel serves, legacy shadows behind it.
  const weServe = freezeEvidence([selection("s1")], diagnostics());
  assert.equal(weServe.census.baselineArm, "legacy");
  assert.equal(weServe.census.servingArm, "ratel");
  assert.equal(weServe.census.tunedArm, "ratel");

  // The demo fixture, and any experiment routed the other way: legacy serves and
  // Ratel shadows. Taking the serving arm here would tune the INCUMBENT's misses
  // against the incumbent's own lists, and quietly rewrite nothing that matters.
  const theyServe: EvaluableSelection = {
    ...selection("s2"),
    arms: [
      { arm: "legacy", role: "serving", resultIds: ["b"], resultScores: null },
      { arm: "ratel", role: "shadow", resultIds: ["a", "b"], resultScores: null },
    ],
  };
  const inverted = freezeEvidence([theyServe], diagnostics());
  assert.equal(inverted.census.baselineArm, "legacy");
  assert.equal(inverted.census.servingArm, "legacy");
  assert.equal(inverted.census.tunedArm, "ratel", "we tune our arm, not the incumbent's");
});

test("with more than two arms the busiest non-baseline one is tuned", () => {
  const many: EvaluableSelection[] = [
    {
      ...selection("s1"),
      arms: [
        { arm: "legacy", role: "serving", resultIds: ["b"], resultScores: null },
        { arm: "ratel", role: "shadow", resultIds: ["a"], resultScores: null },
        { arm: "experimental", role: "shadow", resultIds: ["c"], resultScores: null },
      ],
    },
    {
      ...selection("s2"),
      arms: [
        { arm: "legacy", role: "serving", resultIds: ["b"], resultScores: null },
        { arm: "ratel", role: "shadow", resultIds: ["a"], resultScores: null },
      ],
    },
  ];
  assert.equal(pickTunedArm(many, "legacy"), "ratel");
});

test("a window with only the baseline has no arm to tune", () => {
  assert.equal(pickTunedArm([], "legacy"), null);
  const only: EvaluableSelection = {
    ...selection("s1"),
    arms: [{ arm: "legacy", role: "serving", resultIds: ["b"], resultScores: null }],
  };
  assert.equal(pickTunedArm([only], "legacy"), null);
});

test("an invoked tool makes the target revealed; otherwise it falls back to the baseline's top", () => {
  const { items, census } = freezeEvidence(
    [selection("s1", { invokedToolId: "invoked_one" }), selection("s2")],
    diagnostics(),
  );
  assert.deepEqual(
    items.map((item) => [item.targetEntryId, item.targetSource]),
    [
      ["invoked_one", "invoked"],
      ["b", "reference"],
    ],
  );
  assert.equal(census.revealedN, 1);
  assert.equal(census.referenceN, 1);
  assert.equal(census.revealedSource, "experiment-invocation");
});

test("the trace-events lane supplies a target when the experiment lane has none", () => {
  const { items, census } = freezeEvidence(
    [selection("s1")],
    diagnostics(),
    new Map([["s1", "from_trace_lane"]]),
  );
  assert.equal(items[0].targetEntryId, "from_trace_lane");
  assert.equal(items[0].targetSource, "invoked");
  assert.equal(census.revealedSource, "trace-events");
  assert.equal(census.attributionMode, "tool-id");
});

test("the experiment lane wins a tie, so a run agrees with the meter beside it", () => {
  const { items } = freezeEvidence(
    [selection("s1", { invokedToolId: "from_experiment" })],
    diagnostics(),
    new Map([["s1", "from_trace_lane"]]),
  );
  assert.equal(items[0].targetEntryId, "from_experiment");
});

test("both lanes contributing is reported as both", () => {
  const { census } = freezeEvidence(
    [selection("s1", { invokedToolId: "x" }), selection("s2")],
    diagnostics(),
    new Map([["s2", "y"]]),
  );
  assert.equal(census.revealedSource, "both");
  assert.equal(census.revealedN, 2);
});

test("a selection with no answer is kept unanswered for the judge, never scored as a miss", () => {
  const orphan: EvaluableSelection = {
    ...selection("s1"),
    arms: [
      { arm: "ratel", role: "serving", resultIds: ["a"], resultScores: null },
      { arm: "legacy", role: "shadow", resultIds: [], resultScores: null },
    ],
  };
  const { items, census } = freezeEvidence([orphan], diagnostics());
  // Unanswered: the reference tier with an empty target, which every scorer and
  // the candidate picker leave out, and which the judge can still answer.
  assert.deepEqual(
    items.map((item) => [item.targetSource, item.targetEntryId]),
    [["reference", ""]],
  );
  assert.equal(census.referenceN, 1);
});

test("one engine alone is ours to tune, not a baseline", () => {
  const only: EvaluableSelection = {
    ...selection("s1"),
    arms: [{ arm: "ratel", role: "serving", resultIds: ["a"], resultScores: null }],
  };
  const { census } = freezeEvidence([only], diagnostics());
  assert.equal(census.baselineArm, null);
  assert.equal(census.tunedArm, "ratel");
});

test("uncaptured queries count toward ranking evidence but not toward captured", () => {
  const { census } = freezeEvidence(
    [selection("s1", { query: null }), selection("s2", { query: "  " }), selection("s3")],
    diagnostics(),
  );
  assert.equal(census.selectionsEvaluated, 3);
  assert.equal(census.queriesCaptured, 1);
});

test("an over-cap window keeps the newest searches and says it truncated", () => {
  const many = [
    selection("old", { minutesAgo: 500 }),
    selection("newer", { minutesAgo: 10 }),
    selection("newest", { minutesAgo: 1 }),
  ];
  const { items, census } = freezeEvidence(many, diagnostics(), new Map(), 2);
  assert.deepEqual(
    items.map((item) => item.selectionId),
    ["newest", "newer"],
  );
  assert.equal(census.truncated, true);
});

test("arms are frozen by value, so a later mutation cannot rewrite history", () => {
  const live = selection("s1", { invokedToolId: "x", ratel: ["a", "b"] });
  const { items } = freezeEvidence([live], diagnostics());
  (live.arms[0].resultIds as string[]).push("mutated");
  assert.deepEqual(items[0].arms[0].resultIds, ["a", "b"]);
});

function census(overrides: Partial<RunCensus> = {}): RunCensus {
  return {
    selectionsEvaluated: 100,
    revealedN: 100,
    referenceN: 0,
    judgedN: 0,
    queriesCaptured: 100,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: null,
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
    ...overrides,
  };
}

test("a healthy census spends the model call", () => {
  assert.equal(declineReason(census()), null);
});

test("too few scored searches declines rather than guessing", () => {
  const reason = declineReason(census({ selectionsEvaluated: MIN_EVALUABLE_SEARCHES - 1 }));
  assert.match(reason ?? "", /below the 20 needed/);
  assert.match(reason ?? "", /Widen the window/);
});

test("almost no captured query text declines and names the fix", () => {
  const reason = declineReason(
    census({ selectionsEvaluated: 100, queriesCaptured: MIN_CAPTURED_QUERIES - 1 }),
  );
  assert.match(reason ?? "", /have their query text stored/);
  assert.match(reason ?? "", /content capture/);
});

// — retrieval observation ---------------------------------------------------

type FakeRow = { payload: unknown; topK: number | null };

/** The minimum drizzle chain `observeRetrieval` walks. */
function fakeDb(rows: FakeRow[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as never;
}

const WINDOW = { since: new Date("2026-09-01T00:00:00Z"), until: new Date("2026-09-14T00:00:00Z") };

test("stages are read from the payload the parser preserved", async () => {
  const observed = await observeRetrieval(
    "p",
    WINDOW,
    fakeDb([{ payload: { stages: ["bm25", "dense", "rrf"] }, topK: 5 }]),
  );
  assert.deepEqual(observed.stages, ["bm25", "dense", "rrf"]);
  assert.equal(observed.topK, 5);
  assert.equal(observed.samples, 1);
});

test("a stage list written as prose is split rather than discarded", async () => {
  const observed = await observeRetrieval(
    "p",
    WINDOW,
    fakeDb([{ payload: { stages: "bm25 -> dense -> rrf" }, topK: null }]),
  );
  assert.deepEqual(observed.stages, ["bm25", "dense", "rrf"]);
});

test("stages reported as objects are read by name", async () => {
  const observed = await observeRetrieval(
    "p",
    WINDOW,
    fakeDb([{ payload: { stages: [{ name: "bm25", ms: 3 }, { stage: "dense" }] }, topK: null }]),
  );
  assert.deepEqual(observed.stages, ["bm25", "dense"]);
});

test("the most common configuration wins, not the most recent", async () => {
  const observed = await observeRetrieval(
    "p",
    WINDOW,
    fakeDb([
      { payload: { stages: ["bm25"] }, topK: null },
      { payload: { stages: ["bm25", "dense", "rrf"] }, topK: null },
      { payload: { stages: ["bm25", "dense", "rrf"] }, topK: null },
    ]),
  );
  assert.deepEqual(observed.stages, ["bm25", "dense", "rrf"]);
  assert.equal(observed.samples, 3);
});

test("no reported stages is an absence, never a guessed default", async () => {
  const observed = await observeRetrieval(
    "p",
    WINDOW,
    fakeDb([
      { payload: { took_ms: 4 }, topK: 5 },
      { payload: null, topK: null },
    ]),
  );
  assert.deepEqual(observed.stages, []);
  assert.equal(observed.samples, 0);
});

test("a window over the cap is thinned across its whole span, not cut to the newest", () => {
  // Thirty days of one search an hour, far past the cap. Taking the newest N
  // would keep a single day and call it a month.
  const selections = Array.from({ length: 720 }, (_, index) =>
    // minutesAgo walks backwards an hour at a time, so the set spans 30 days.
    selection(`s${index}`, { minutesAgo: index * 60, invokedToolId: "tool_a" }),
  );
  const { items, census } = freezeEvidence(selections, diagnostics(), new Map(), 24);

  assert.equal(items.length, 24);
  assert.equal(census.truncated, true);
  const days = new Set(items.map((item) => item.occurredAt.toISOString().slice(0, 10)));
  // A newest-first cut would land inside one or two days; a stride spans them.
  assert.ok(days.size >= 20, `expected the sample to span the window, got ${days.size} days`);
});

test("a window inside the cap is frozen whole and says so", () => {
  const selections = Array.from({ length: 5 }, (_, index) =>
    selection(`s${index}`, { invokedToolId: "tool_a" }),
  );
  const { items, census } = freezeEvidence(selections, diagnostics(), new Map(), 24);
  assert.equal(items.length, 5);
  assert.equal(census.truncated, false);
});
