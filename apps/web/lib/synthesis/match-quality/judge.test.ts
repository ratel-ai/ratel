import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import type { EvalItem, TargetSource } from "@/lib/synthesis/match-quality/types";
import {
  applyVerdicts,
  identityFingerprint,
  type JudgeCase,
  type JudgeEngine,
  judgeTargets,
  labelsFromVerdicts,
  sampleForJudging,
  stratifiedAccuracy,
  validateVerdicts,
} from "./judge";

const OURS = "ratel";
const BASE = "legacy";

function item(
  id: string,
  opts: {
    query?: string | null;
    target?: string;
    source?: TargetSource;
    ours?: string[];
    base?: string[];
  } = {},
): EvalItem {
  return {
    selectionId: id,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    query: opts.query === undefined ? `query ${id}` : opts.query,
    targetEntryId: opts.target ?? "tool_a",
    targetKind: "tool",
    targetSource: opts.source ?? "reference",
    arms: [
      { arm: OURS, role: "serving", resultIds: opts.ours ?? ["tool_b"], resultScores: null },
      { arm: BASE, role: "shadow", resultIds: opts.base ?? ["tool_a"], resultScores: null },
    ],
  };
}

const CORPUS: CorpusEntry[] = ["tool_a", "tool_b", "tool_c"].map((entryId) => ({
  entryId,
  name: entryId,
  searchable: `does ${entryId} things`,
  source: "runtime",
  matchesAgentDescription: false,
  tags: [],
}));

test("an invoked target is never sent to the judge", () => {
  const { cases } = sampleForJudging([item("a", { source: "invoked" }), item("b")], OURS, BASE);
  assert.deepEqual(
    cases.map((row) => row.id),
    ["b"],
  );
});

test("a search with no captured query is skipped", () => {
  const { cases } = sampleForJudging([item("a", { query: null })], OURS, BASE);
  assert.equal(cases.length, 0);
});

test("repeated phrasings spend one judgment", () => {
  const rows = [
    item("a", { query: "Deploy the service" }),
    item("b", { query: "  deploy   the service  " }),
    item("c", { query: "something else" }),
  ];
  const { cases } = sampleForJudging(rows, OURS, BASE);
  assert.deepEqual(
    cases.map((row) => row.id),
    ["a", "c"],
  );
});

test("the strata split on whether the two engines led with the same result", () => {
  const rows = [
    item("dispute", { ours: ["tool_b"], base: ["tool_a"] }),
    item("agree", { ours: ["tool_a", "tool_c"], base: ["tool_a"] }),
  ];
  const { cases, populationDisputed, populationControl } = sampleForJudging(rows, OURS, BASE);
  assert.equal(populationDisputed, 1);
  assert.equal(populationControl, 1);
  assert.deepEqual(
    cases.map((row) => [row.id, row.stratum]),
    [
      ["dispute", "disputed"],
      ["agree", "control"],
    ],
  );
});

test("the shortlist merges both arms and carries no arm ordering", () => {
  const rows = [item("a", { ours: ["tool_b", "tool_c"], base: ["tool_a"] })];
  const { cases } = sampleForJudging(rows, OURS, BASE);
  const shortlist = cases[0]?.shortlist ?? [];
  assert.deepEqual([...shortlist].sort(), ["tool_a", "tool_b", "tool_c"]);
  // Stable across calls, so a re-run and a snapshot both hold.
  const again = sampleForJudging(rows, OURS, BASE).cases[0]?.shortlist ?? [];
  assert.deepEqual(shortlist, again);
});

test("the control sample strides the population instead of taking the newest", () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    item(`c${index}`, { query: `q${index}`, ours: ["tool_a"], base: ["tool_a"] }),
  );
  const { cases } = sampleForJudging(rows, OURS, BASE, { maxControl: 3 });
  assert.deepEqual(
    cases.map((row) => row.id),
    ["c0", "c3", "c6"],
  );
});

test("a case carries no arm labels and no assumed target", () => {
  const { cases } = sampleForJudging([item("a", { query: "how do I deploy" })], OURS, BASE);
  const sent = JSON.stringify(cases.map(({ id, query, shortlist }) => ({ id, query, shortlist })));
  assert.ok(!sent.includes(OURS));
  assert.ok(!sent.includes(BASE));
  assert.ok(sent.includes("how do I deploy"));
});

test("an entry id the catalog does not hold is read as an abstention", () => {
  const verdicts = validateVerdicts(
    [
      { id: "a", entryId: "tool_invented", confident: true },
      { id: "b", entryId: "tool_c", confident: true },
      { id: "not-a-case", entryId: "tool_a", confident: true },
      { id: "b", entryId: "tool_a", confident: true },
    ],
    new Set(["a", "b"]),
    new Set(["tool_a", "tool_b", "tool_c"]),
  );
  assert.deepEqual(verdicts, [
    { id: "a", entryId: "", confident: true },
    { id: "b", entryId: "tool_c", confident: true },
  ]);
});

test("an abstention leaves the item exactly where the reference tier put it", () => {
  const items = [item("a", { target: "tool_a" })];
  const cases: JudgeCase[] = [
    { id: "a", query: "q", shortlist: [], assumed: "tool_a", stratum: "disputed" },
  ];
  const { items: next, census } = applyVerdicts(
    items,
    cases,
    [{ id: "a", entryId: "", confident: false }],
    { disputed: 1, control: 0, nominatingPopulation: 0, nominatingSampled: 0 },
    { model: "m", mocked: false },
  );
  assert.equal(next[0]?.targetSource, "reference");
  assert.equal(next[0]?.targetEntryId, "tool_a");
  assert.equal(census.abstained, 1);
  assert.equal(census.referenceAccuracy, null);
});

test("agreeing with the reference target still promotes the item off the assumption", () => {
  const items = [item("a", { target: "tool_a" })];
  const cases: JudgeCase[] = [
    { id: "a", query: "q", shortlist: [], assumed: "tool_a", stratum: "control" },
  ];
  const { items: next, census } = applyVerdicts(
    items,
    cases,
    [{ id: "a", entryId: "tool_a", confident: true }],
    { disputed: 0, control: 1, nominatingPopulation: 0, nominatingSampled: 0 },
    { model: "m", mocked: false },
  );
  assert.equal(next[0]?.targetSource, "judge");
  assert.equal(next[0]?.targetEntryId, "tool_a");
  assert.equal(census.changed, 0);
  assert.equal(census.agreedControl, 1);
  assert.equal(census.referenceAccuracy, 1);
});

test("a verdict that moves the target is counted as changed", () => {
  const items = [item("a", { target: "tool_a" })];
  const cases: JudgeCase[] = [
    { id: "a", query: "q", shortlist: [], assumed: "tool_a", stratum: "disputed" },
  ];
  const { items: next, census } = applyVerdicts(
    items,
    cases,
    [{ id: "a", entryId: "tool_c", confident: true }],
    { disputed: 1, control: 0, nominatingPopulation: 0, nominatingSampled: 0 },
    { model: "m", mocked: false },
  );
  assert.equal(next[0]?.targetEntryId, "tool_c");
  assert.equal(next[0]?.targetSource, "judge");
  assert.equal(census.changed, 1);
  assert.equal(census.referenceAccuracy, 0);
});

test("reference accuracy weights each stratum by its population, not its sample", () => {
  // Disagreements are rare and mostly wrong; agreements are common and mostly
  // right. A raw hit rate over the judged set would report 50%. The population
  // shares say otherwise, which is the entire reason the control stratum exists.
  const estimate = stratifiedAccuracy(
    { answered: 10, agreed: 2, population: 20 },
    { answered: 10, agreed: 9, population: 180 },
  );
  assert.ok(estimate !== null);
  assert.equal(Number(estimate.toFixed(4)), Number((0.2 * 0.1 + 0.9 * 0.9).toFixed(4)));
});

test("a stratum nobody answered is dropped rather than assumed", () => {
  const estimate = stratifiedAccuracy(
    { answered: 0, agreed: 0, population: 500 },
    { answered: 4, agreed: 3, population: 100 },
  );
  assert.equal(estimate, 0.75);
});

function engine(judge: JudgeEngine["judge"]): JudgeEngine {
  return { model: "m", judge };
}

test("judgeTargets returns null when there is nothing worth judging", async () => {
  let called = false;
  const result = await judgeTargets(
    [item("a", { source: "invoked" })],
    CORPUS,
    OURS,
    BASE,
    engine(async () => {
      called = true;
      return [];
    }),
  );
  assert.equal(result, null);
  assert.equal(called, false);
});

test("judgeTargets hands the sampled cases and the whole corpus to the engine", async () => {
  let seen: readonly JudgeCase[] = [];
  let corpusSeen = 0;
  const result = await judgeTargets(
    [item("a", { target: "tool_a", ours: ["tool_b"], base: ["tool_a"] })],
    CORPUS,
    OURS,
    BASE,
    engine(async (cases, corpus) => {
      seen = cases;
      corpusSeen = corpus.length;
      return cases.map((row) => ({ id: row.id, entryId: "tool_c", confident: true }));
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(corpusSeen, CORPUS.length);
  assert.equal(result?.items[0]?.targetEntryId, "tool_c");
  assert.equal(result?.census.changed, 1);
  assert.equal(result?.census.model, "m");
});

test("an engine that invents an entry cannot move a target", async () => {
  const result = await judgeTargets(
    [item("a", { target: "tool_a", ours: ["tool_b"], base: ["tool_a"] })],
    CORPUS,
    OURS,
    BASE,
    engine(async (cases) =>
      cases.map((row) => ({ id: row.id, entryId: "tool_ghost", confident: true })),
    ),
  );
  assert.equal(result?.items[0]?.targetEntryId, "tool_a");
  assert.equal(result?.items[0]?.targetSource, "reference");
  assert.equal(result?.census.abstained, 1);
});

test("a case the engine left out stays on the reference tier", async () => {
  const result = await judgeTargets(
    [
      item("a", { query: "q1", target: "tool_a", ours: ["tool_b"], base: ["tool_a"] }),
      item("b", { query: "q2", target: "tool_a", ours: ["tool_b"], base: ["tool_a"] }),
    ],
    CORPUS,
    OURS,
    BASE,
    engine(async () => [{ id: "a", entryId: "tool_c", confident: true }]),
  );
  assert.equal(result?.items.find((row) => row.selectionId === "b")?.targetSource, "reference");
  assert.equal(result?.census.answeredDisputed, 1);
});

test("every distinct search is judged, not a sample", () => {
  const rows = Array.from({ length: 300 }, (_, index) =>
    item(`s${index}`, {
      query: `q${index}`,
      ours: index % 2 === 0 ? ["tool_a"] : ["tool_b"],
      base: ["tool_a"],
    }),
  );
  const { cases } = sampleForJudging(rows, OURS, BASE);
  assert.equal(cases.length, 300);
});

test("a disagreement already driving a nomination jumps the queue", () => {
  const rows = [
    item("filler-1", { query: "q1", ours: ["tool_b"], base: ["tool_a"] }),
    item("filler-2", { query: "q2", ours: ["tool_b"], base: ["tool_a"] }),
    item("nominating", { query: "q3", ours: ["tool_b"], base: ["tool_a"] }),
  ];
  const { cases, nominatingPopulation, nominatingSampled } = sampleForJudging(rows, OURS, BASE, {
    maxDisputed: 1,
    priority: new Set(["nominating"]),
  });
  assert.deepEqual(
    cases.map((row) => row.id),
    ["nominating"],
  );
  assert.equal(nominatingPopulation, 1);
  assert.equal(nominatingSampled, 1);
});

test("priority never reorders the control stratum, because it is the measurement", () => {
  const rows = Array.from({ length: 6 }, (_, index) =>
    item(`c${index}`, { query: `q${index}`, ours: ["tool_a"], base: ["tool_a"] }),
  );
  const plain = sampleForJudging(rows, OURS, BASE, { maxControl: 2 });
  const prioritised = sampleForJudging(rows, OURS, BASE, {
    maxControl: 2,
    priority: new Set(["c5"]),
  });
  assert.deepEqual(
    plain.cases.map((row) => row.id),
    prioritised.cases.map((row) => row.id),
  );
});

/* — the answer key drives what is judged ------------------------------------ */

function label(
  query: string,
  entryId: string,
  opts: { source?: "judge" | "unclear" | "invoked"; fingerprint?: string | null } = {},
) {
  return {
    queryKey: query,
    query,
    entryId,
    source: opts.source ?? ("judge" as const),
    confident: true,
    model: "jev",
    selectionId: null,
    occurrences: 1,
    observedAt: new Date("2026-09-01T00:00:00Z"),
    catalogFingerprint: opts.fingerprint === undefined ? "fp-now" : opts.fingerprint,
  };
}

test("a request with a fresh verdict is not paid for again; a stale one is re-read", () => {
  const rows = [
    item("fresh", { query: "q fresh", ours: ["tool_b"], base: ["tool_a"] }),
    item("stale", { query: "q stale", ours: ["tool_b"], base: ["tool_a"] }),
    item("unread", { query: "q unread", ours: ["tool_b"], base: ["tool_a"] }),
  ];
  const key = new Map([
    ["q fresh", label("q fresh", "tool_a")],
    ["q stale", label("q stale", "tool_a", { fingerprint: "fp-old" })],
  ]);
  const { cases } = sampleForJudging(rows, OURS, BASE, { key, fingerprint: "fp-now" });
  // Unread first, then stale.
  assert.deepEqual(
    cases.map((row) => row.id),
    ["unread", "stale"],
  );
});

test("an unclear verdict counts as read: it is not asked again until the tools change", () => {
  const rows = [item("u", { query: "q u", ours: ["tool_b"], base: ["tool_a"] })];
  const key = new Map([["q u", label("q u", "", { source: "unclear" })]]);
  assert.equal(sampleForJudging(rows, OURS, BASE, { key, fingerprint: "fp-now" }).cases.length, 0);
});

test("once a stratum has its answers, only a trickle of new requests is judged", () => {
  const rows = Array.from({ length: 40 }, (_, index) =>
    item(`s${index}`, { query: `q${index}`, ours: ["tool_a"], base: ["tool_a"] }),
  );
  const key = new Map(
    Array.from({ length: 20 }, (_, index) => [`q${index}`, label(`q${index}`, "tool_a")] as const),
  );
  const { cases } = sampleForJudging(rows, OURS, BASE, {
    key,
    fingerprint: "fp-now",
    targetPerStratum: 10,
    trickle: 0.25,
  });
  // 20 fresh already exceed the target of 10, so 25% of the 20 unread: 5.
  assert.equal(cases.length, 5);
  assert.ok(cases.every((row) => Number(row.id.slice(1)) >= 20));
});

test("the engine's capacity caps a run, alternating strata so both are measured", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    item(`s${index}`, {
      query: `q${index}`,
      ours: index % 2 === 0 ? ["tool_a"] : ["tool_b"],
      base: ["tool_a"],
    }),
  );
  const { cases } = sampleForJudging(rows, OURS, BASE, { maxCases: 6 });
  assert.equal(cases.length, 6);
  assert.equal(cases.filter((row) => row.stratum === "control").length, 3);
});

test("a verdict reaches every sighting of its request, not only the one asked about", () => {
  const items = [
    item("a", { query: "Close the task", target: "tool_a" }),
    item("b", { query: "close  the task", target: "tool_a" }),
  ];
  const cases: JudgeCase[] = [
    { id: "a", query: "Close the task", shortlist: [], assumed: "tool_a", stratum: "disputed" },
  ];
  const { items: next } = applyVerdicts(
    items,
    cases,
    [{ id: "a", entryId: "tool_c", confident: true }],
    { disputed: 1, control: 0, nominatingPopulation: 0, nominatingSampled: 0 },
    { model: "m", mocked: false },
    BASE,
  );
  assert.deepEqual(
    next.map((row) => [row.targetEntryId, row.targetSource]),
    [
      ["tool_c", "judge"],
      ["tool_c", "judge"],
    ],
  );
});

test("a stale verdict re-read as unclear becomes no answer", () => {
  const items = [item("a", { query: "q", target: "tool_c", source: "judge", base: ["tool_a"] })];
  const cases: JudgeCase[] = [
    { id: "a", query: "q", shortlist: [], assumed: "tool_a", stratum: "disputed" },
  ];
  const { items: next } = applyVerdicts(
    items,
    cases,
    [{ id: "a", entryId: "", confident: false }],
    { disputed: 1, control: 0, nominatingPopulation: 0, nominatingSampled: 0 },
    { model: "m", mocked: false },
    BASE,
  );
  assert.deepEqual([next[0]?.targetEntryId, next[0]?.targetSource], ["tool_a", "reference"]);
});

test("every verdict becomes a label, abstentions as unclear, dated by the judging", () => {
  const judgedAt = new Date("2026-09-29T12:00:00Z");
  const labels = labelsFromVerdicts(
    [
      { id: "a", query: "Close the task", shortlist: [], assumed: "x", stratum: "control" },
      { id: "b", query: "hmm", shortlist: [], assumed: "x", stratum: "control" },
    ],
    [
      { id: "a", entryId: "tool_a", confident: true, confidence: 0.97 },
      { id: "b", entryId: "", confident: false, confidence: 0.4, runnerUp: "tool_b" },
    ],
    { model: "judge-1.13.0", fingerprint: "fp", judgedAt },
  );
  assert.deepEqual(
    labels.map((row) => [row.queryKey, row.source, row.entryId, row.confidence, row.runnerUp]),
    [
      ["close the task", "judge", "tool_a", 0.97, null],
      ["hmm", "unclear", "", 0.4, "tool_b"],
    ],
  );
  assert.ok(labels.every((row) => row.observedAt === judgedAt && row.catalogFingerprint === "fp"));
});

test("the identity fingerprint ignores Ratel overrides but not the customer's own text", () => {
  const base = CORPUS.map((entry) => ({ ...entry, description: `d ${entry.entryId}` }));
  const overridden = base.map((entry) => ({ ...entry, searchable: "a Ratel rewrite" }));
  const edited = base.map((entry, index) =>
    index === 0 ? { ...entry, description: "the customer changed this" } : entry,
  );
  assert.equal(identityFingerprint(base), identityFingerprint(overridden));
  assert.notEqual(identityFingerprint(base), identityFingerprint(edited));
});

test("judgeTargets returns labels and honours the engine's capacity", async () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    item(`s${index}`, { query: `q${index}`, ours: ["tool_b"], base: ["tool_a"] }),
  );
  let asked = 0;
  const result = await judgeTargets(rows, CORPUS, OURS, BASE, {
    model: "m",
    capacity: () => 2,
    judge: async (cases) => {
      asked = cases.length;
      return cases.map((row) => ({ id: row.id, entryId: "tool_c", confident: true }));
    },
  });
  assert.equal(asked, 2);
  assert.equal(result?.labels.length, 2);
});

test("stale verdicts keep being re-read after a stratum has its answers", () => {
  const rows = Array.from({ length: 40 }, (_, index) =>
    item(`s${index}`, { query: `q${index}`, ours: ["tool_a"], base: ["tool_a"] }),
  );
  const key = new Map(
    Array.from(
      { length: 40 },
      (_, index) =>
        [
          `q${index}`,
          label(`q${index}`, "tool_a", { fingerprint: index < 20 ? "fp-now" : "fp-old" }),
        ] as const,
    ),
  );
  const { cases } = sampleForJudging(rows, OURS, BASE, {
    key,
    fingerprint: "fp-now",
    targetPerStratum: 10,
    trickle: 0.25,
  });
  // Target met by the 20 fresh; a quarter of the 20 stale is still re-read.
  assert.equal(cases.length, 5);
});

test("a verdict naming a tool the catalog no longer has is re-read", () => {
  const rows = [item("g", { query: "q g", ours: ["tool_b"], base: ["tool_a"] })];
  const key = new Map([["q g", label("q g", "tool_deleted")]]);
  const { cases } = sampleForJudging(rows, OURS, BASE, {
    key,
    fingerprint: "fp-now",
    corpusIds: new Set(["tool_a", "tool_b"]),
  });
  assert.deepEqual(
    cases.map((row) => row.id),
    ["g"],
  );
});

test("with no baseline every unread search is one stratum and still judged", () => {
  const rows = [0, 1, 2].map((index) => ({
    ...item(`s${index}`, { query: `q${index}` }),
    arms: [{ arm: OURS, role: "serving" as const, resultIds: ["tool_b"], resultScores: null }],
    targetEntryId: "",
  }));
  const { cases } = sampleForJudging(rows, OURS, "");
  assert.equal(cases.length, 3);
  assert.ok(cases.every((row) => row.stratum === "disputed" && row.assumed === ""));
});
