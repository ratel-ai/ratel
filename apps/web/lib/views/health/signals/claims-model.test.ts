import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNAL_CATALOG } from "@/lib/readings/trace-signals/signals/catalog";
import { SIGNAL_KINDS, type SignalKind } from "@/lib/readings/trace-signals/view";
import { claimModel, duration, type SignalRecord } from "@/lib/views/health/signals/claims-model";

/** Awkward numbers on purpose: every one of them could print two decimals. */
const METRICS: Record<string, unknown> = {
  k: 21.4,
  n: 59.6,
  share: 0.35678,
  low: 0.25123,
  high: 0.48456,
  extraSearches: 27.25,
  inFirstSearchLow: 3,
  medianRank: 7.5,
  minRank: 4,
  rankBands: [47, 12, 29, 0],
  impressions: 509,
  picks: 3,
  listShare: 0.41234,
  pickShare: 0.00589,
  impressionsTop3: 402,
  dead: 23,
  catalogTools: 93,
  shareOfB: 0.77966,
  turnsB: 76,
  viaSearch: 29,
  relation: "co_occurrence",
  swaps: 14,
  decisionTurns: 33,
  errors: 17,
  loopTurns: 5,
  retries: 12,
  abandoned: 240.5,
  turns: 774,
  junkShare: 0.57938,
  junkHits: 7190.4,
  scoredHits: 12410,
  medianTopK: 10,
  pickCutoff: 5,
  belowCutoffShare: 0.02345,
  picksBelowCutoff: 21,
  suggestedTopK: 5,
  p95Ms: 12_437.6,
  medianMs: 1_412.3,
  calls: 142,
  distinct: 5,
  top: 4,
  extraCalls: 9,
  minCalls: 3,
  singletons: 209,
  clusters: 232,
};

function record(kind: SignalKind, overrides: Partial<SignalRecord> = {}): SignalRecord {
  const pair = SIGNAL_CATALOG[kind].subjectKind === "tool_pair";
  return {
    id: `sig-${kind}`,
    kind,
    status: "open",
    tier: "deterministic",
    subjectKind: SIGNAL_CATALOG[kind].subjectKind,
    subjectKey: pair ? "find_task>assign_task" : "create_task",
    subjectIds: pair
      ? ["find_task", "assign_task"]
      : kind === "dead_tool"
        ? ["archive_project"]
        : ["create_task"],
    entryKind: "tool",
    severity: 0.5,
    impact: 10,
    n: 60,
    metrics: METRICS,
    turnIds: [],
    traceEventIds: [],
    totalTurns: 0,
    turnSourceMix: { declared: 10, inferred: 0, otlp: 0 },
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

const NAMES = new Map([
  ["create_task", "Create task"],
  ["find_task", "Find task"],
  ["assign_task", "Assign task"],
]);

test("every kind renders a claim, figure, cost and fix without two-decimal numbers or em dashes", () => {
  for (const kind of SIGNAL_KINDS) {
    const model = claimModel(record(kind), NAMES, 30);
    const strings = [
      model.claim,
      model.figure.display,
      model.figure.raw,
      model.cost,
      model.fix,
      model.caveat ?? "",
      model.subject.label,
    ];
    for (const text of strings) {
      assert.ok(text.length > 0 || text === model.caveat || text === "", `${kind} has empty copy`);
      assert.doesNotMatch(text, /\d\.\d\d/, `${kind}: "${text}"`);
      assert.doesNotMatch(text, /\u2014/, `${kind}: "${text}"`);
    }
    assert.ok(model.claim.length > 0 && model.fix.length > 0 && model.cost.length > 0, kind);
    assert.equal(model.claimSegments.map((s) => s.text).join(""), model.claim, kind);
  }
});

test("subject chips carry catalog names and ids in claim order", () => {
  const model = claimModel(record("sequence_chain"), NAMES, 30);
  // The share is of the second tool's turns (`shareOfB`), so the sentence has
  // to say whose runs it counts; "its runs" read as the first tool's.
  assert.equal(
    model.claim,
    "Find task precedes Assign task in 78% of the turns that run Assign task.",
  );
  const subjects = model.claimSegments.filter((s) => s.kind === "subject");
  assert.deepEqual(
    subjects.map((s) => (s.kind === "subject" ? s.chipId : "")),
    ["find_task", "assign_task"],
  );
  assert.deepEqual(
    model.subject.chips.map((c) => c.label),
    ["Find task", "Assign task"],
  );
  assert.equal(model.subject.label, "Find task then Assign task");
  assert.equal(
    model.caveat,
    "The two also run in the other order, so this is a habit more than a dependency.",
  );
});

test("the fixture's tone: magnet, latency and dead tools", () => {
  const magnet = claimModel(record("magnet"), NAMES, 30);
  assert.equal(magnet.claim, "Create task rides into 41% of lists and is picked in 1%.");
  assert.equal(magnet.figure.raw, "509 lists · 3 picks");
  const latency = claimModel(record("latency_outlier"), NAMES, 30);
  assert.equal(
    latency.claim,
    "Create task's slowest calls take 12.4 s, against 1.4 s for a typical call.",
  );
  assert.equal(latency.cost, "About 26 minutes of waiting.");
  const dead = claimModel(record("dead_tool"), NAMES, 30);
  assert.equal(dead.claim, "23 tools were never listed and never run.");
  assert.equal(dead.fixRoute, "retire_tool");
});

test("the e2e magnet: 3 picks in 774 lists never reads as 0%", () => {
  const magnet = claimModel(
    record("magnet", {
      metrics: {
        ...METRICS,
        impressions: 774,
        searches: 1_548,
        picks: 3,
        listShare: 0.5,
        pickShare: 0.0039,
      },
    }),
    NAMES,
    30,
  );
  assert.equal(magnet.claim, "Create task rides into 50% of lists and is picked in <1%.");
  assert.equal(magnet.figure.raw, "774 lists · 3 picks");
  const never = claimModel(
    record("magnet", { metrics: { ...METRICS, picks: 0, pickShare: 0 } }),
    NAMES,
    30,
  );
  assert.match(never.claim, /is never picked\.$/);
});

/**
 * Every share the cards print, driven by counts at both edges: one of many
 * (a real share that rounds to 0) and all but one of many (one that rounds to
 * 100). Neither may print "0%" or "100%"; a zero count must print "0%" or
 * "never", and a full count "100%".
 */
test("no claim or figure rounds a nonzero share to 0% or a partial share to 100%", () => {
  const edges = (k: number, n: number): Record<string, unknown> => ({
    ...METRICS,
    // first_try_miss, no_follow_through, buried_tool
    k,
    n,
    share: k / n,
    // magnet
    impressions: n,
    searches: n,
    picks: k,
    listShare: 1,
    pickShare: k / n,
    // sequence_chain
    turnsB: n,
    shareOfB: k / n,
    // abandoned_search
    abandoned: k,
    turns: n,
    // padding_share (junk and by-rank)
    junkHits: k,
    scoredHits: n,
    junkShare: k / n,
    picksBelowCutoff: k,
    belowCutoffShare: k / n,
    // unstable_intent, fragmented_intents
    top: k,
    topShare: k / n,
    singletons: k,
    clusters: n,
    // wait_heavy: time inside the tool of all turn time
    timeMs: k,
    turnMs: n,
    // token_heavy: the heavy turns' share of turns and of tokens
    turnShare: k / n,
    tokenShare: k / n,
    heavyTokens: 1,
    totalTokens: n,
    // system_turn_failing: person-started turns
    personFailed: k,
    personTurns: n,
    personShare: k / n,
    // agent_failing
    othersShare: k / n,
    // workflow_failing, workflow_fixed_chain, workflow_slow
    runs: n,
    failedRuns: k,
    completion: 1 - k / n,
    orderRuns: n,
    orderStableRuns: k,
    orderStability: k / n,
    slowestStepShare: k / n,
  });
  const standaloneZero = /(^|[^\d<>.])0%/;
  for (const kind of SIGNAL_KINDS) {
    for (const [k, n] of [
      [1, 1_000],
      [3, 774],
      [999, 1_000],
      [773, 774],
    ] as const) {
      // A chain counts its pairs in `n`, out of the second tool's turns; padding
      // counts picks below the cutoff out of all `picks`.
      const metrics =
        kind === "sequence_chain"
          ? { ...edges(k, n), n: k }
          : kind === "padding_share"
            ? { ...edges(k, n), picks: n }
            : edges(k, n);
      const model = claimModel(record(kind, { metrics }), NAMES, 30);
      for (const text of [model.claim, model.figure.display]) {
        assert.doesNotMatch(text, standaloneZero, `${kind} ${k}/${n}: "${text}"`);
        if (kind !== "magnet")
          assert.doesNotMatch(text, /(^|[^\d])100%/, `${kind} ${k}/${n}: "${text}"`);
      }
    }
    const none = claimModel(record(kind, { metrics: edges(0, 500) }), NAMES, 30);
    assert.doesNotMatch(none.figure.display, /<1%|>99%/, `${kind}: zero is zero`);
  }
  const padding = claimModel(
    record("padding_share", { metrics: { ...edges(0, 500), junkShare: undefined } }),
    NAMES,
    30,
  );
  assert.match(padding.claim, / are 0%\.$/);
  const all = claimModel(record("abandoned_search", { metrics: edges(500, 500) }), NAMES, 30);
  assert.equal(all.figure.display, "100%");
});

test("a stored route wins over the catalog default, and inferred turns add a caveat", () => {
  const model = claimModel(
    record("first_try_miss", {
      metrics: { ...METRICS, route: "adaptive_ranking" },
      turnSourceMix: { declared: 0, inferred: 9, otlp: 1 },
    }),
    NAMES,
    30,
  );
  assert.equal(model.fixRoute, "adaptive_ranking");
  assert.match(model.fix, /Have Ratel rank .+ higher/);
  assert.equal(
    model.caveat,
    "Turn boundaries here are inferred from timing, not declared by the SDK.",
  );
  assert.deepEqual(model.interval, { low: 0.25123, high: 0.48456 });
});

test("buried tools carry a rank histogram; unknown ids fall back to the id", () => {
  const model = claimModel(record("buried_tool", { subjectIds: ["mystery_tool"] }), NAMES, 30);
  assert.equal(model.chart?.kind, "rank_histogram");
  assert.match(model.claim, /^mystery_tool is the right tool/);
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(12_437), "12.4 s");
});

test("the padding claim states the same share its big figure shows", () => {
  const model = claimModel(
    record("padding_share", {
      metrics: {
        medianTopK: 10,
        pickCutoff: 5,
        junkHits: 2986,
        scoredHits: 3934,
        junkShare: 2986 / 3934,
        picks: 400,
        picksBelowCutoff: 16,
        belowCutoffShare: 16 / 400,
      },
    }),
    NAMES,
    30,
  );
  assert.equal(model.figure.display, "76%");
  assert.match(
    model.claim,
    /^Lists are filled to 10, and 76% of what they show scores far below the top hit\.$/,
  );
  assert.match(model.cost, /picked below #5 in 4% of its picks/);
});

test("no customer-facing line names an engine or a statistic", () => {
  const ENGINE = /adaptive ranking|match quality|intent extraction|\bp95\b|\bmedian\b/i;
  for (const kind of SIGNAL_KINDS) {
    for (const route of [undefined, "adaptive_ranking", "lower_top_k", "rewrite_description"]) {
      const model = claimModel(
        record(kind, route ? { metrics: { ...METRICS, route } } : {}),
        NAMES,
        30,
      );
      for (const line of [model.claim, model.fix, model.cost, model.figure.raw]) {
        assert.doesNotMatch(String(line ?? ""), ENGINE, `${kind}/${route ?? "default"}: ${line}`);
      }
    }
  }
});

test("self-corrections: a tool's claim, the most common kinds, and the fix its pattern calls for", () => {
  const metrics = {
    k: 12,
    n: 40,
    share: 0.3,
    events: 24,
    retried: 12,
    gaveUp: 8,
    apologized: 4,
    pattern: "failed",
    fixTool: "create_task",
  };
  const tool = claimModel(record("self_correcting", { metrics }), NAMES, 30);
  assert.equal(
    tool.claim,
    "The agent corrects itself after Create task in 30% of the turns that call it.",
  );
  assert.equal(
    tool.cost,
    "24 self-corrections in the last 30 days: 12 retries after an error, 8 give-ups and 4 apologies.",
  );
  assert.equal(tool.fix, "Make Create task fail with a clear message, or retry inside the tool.");
  assert.equal(tool.figure.display, "30%");
  assert.equal(tool.figure.raw, "12 of 40 turns");
  assert.equal(tool.figure.caption, "self-corrected");
  const empty = claimModel(
    record("self_correcting", { metrics: { ...metrics, pattern: "empty" } }),
    NAMES,
    30,
  );
  assert.equal(empty.fix, "Add a skill that says what to do when Create task returns nothing.");
});

test("self-corrections: a task's claim names the task, and its fix the tool or the topic", () => {
  const task = (metrics: Record<string, unknown>) =>
    claimModel(
      record("self_correcting", {
        subjectKind: "workflow",
        subjectKey: "wf-1",
        subjectIds: ["find_task", "assign_task"],
        metrics: { k: 9, n: 30, share: 0.3, events: 9, ...metrics },
      }),
      NAMES,
      30,
      new Map([["wf-1", { name: "Assign work" }]]),
    );
  const backtrack = task({ backtracked: 9, pattern: "backtrack", fixTool: "assign_task" });
  assert.equal(backtrack.claim, "The agent corrects itself in 30% of runs of Assign work.");
  assert.equal(backtrack.figure.raw, "9 of 30 runs");
  assert.equal(backtrack.fix, "Rewrite Assign task's searchable description.");
  assert.equal(backtrack.cost, "9 self-corrections in the last 30 days: 9 backtracks.");
  assert.equal(
    task({ apologized: 9, pattern: "unanswered", fixTool: null, topicName: "Refund requests" }).fix,
    "Build a tool or add a skill for Refund requests.",
  );
  assert.equal(
    task({ apologized: 9, pattern: "unanswered", fixTool: null }).fix,
    "Build a tool or add a skill for Assign work.",
    "no topic known: the task stands in",
  );
});
