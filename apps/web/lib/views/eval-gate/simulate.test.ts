import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import {
  changeOf,
  describeChange,
  emptyChange,
  parseChange,
  parseCrafted,
  topKFromTitle,
} from "./change";
import {
  defaultExpected,
  describeExpected,
  neededCalls,
  parseExpected,
  wantedTool,
} from "./defaults";
import { createRanker } from "./ranker";
import { checkSide, scoreCase, summarize } from "./score";
import { affects, type Ranker, recordedView, simulateRun, windowOf } from "./simulate";
import {
  type FixChange,
  type InvokeStep,
  NO_EXPECTATION,
  type RunRecord,
  type RunStep,
  type RunView,
} from "./types";
import { badgeSentence, evalHref, fixIdFromSegment, passLine, simulatedLabel } from "./view";

const search = (
  ordinal: number,
  hitIds: string[] | null,
  query: string | null = null,
  topK: number | null = null,
): RunStep => ({ kind: "search", ordinal, query, hitIds, topK });
const call = (
  ordinal: number,
  targetId: string,
  outcome: InvokeStep["outcome"] = "ok",
): RunStep => ({ kind: "invoke", ordinal, targetId, outcome });
const run = (steps: RunStep[], turnId = "00000000-0000-4000-8000-000000000001"): RunRecord => ({
  turnId,
  traceId: "t1",
  startedAt: "2026-10-20T00:00:00.000Z",
  taskId: null,
  steps,
});
const change = (over: Partial<FixChange>): FixChange => ({ ...emptyChange(), ...over });

/* - change ------------------------------------------------------------------- */

test("every fix kind Fixes builds becomes a change, or says why it can't be simulated", () => {
  const model = buildFixes(fixesInput());
  assert.ok(model.open.length > 0);
  for (const fix of model.open) {
    const result = changeOf(fix);
    const hasSomething =
      Object.keys(result.patches).length > 0 ||
      result.hide.length +
        result.add.length +
        result.collapse.length +
        result.dedupeRetries.length +
        result.skillSteps.length >
        0 ||
      result.topK !== null;
    assert.ok(
      hasSomething !== (result.unsupportedReason !== null),
      `${fix.id} (${fix.kind}) has a change or a reason, not both`,
    );
  }
});

test("a rewrite patches its tool with the proposed text", () => {
  const fix = buildFixes(fixesInput()).open.find((item) => item.source === "rewrite");
  assert.ok(fix);
  const result = changeOf(fix);
  assert.equal(
    result.patches.lookup_order,
    "Look up an order. Use for order status, tracking and where is my order.",
  );
  assert.equal(result.unsupportedReason, null);
});

test("build, split and preload are not simulated", () => {
  const fix = buildFixes(fixesInput()).open[0]!;
  for (const kind of ["build", "split", "preload"] as const) {
    assert.ok(changeOf({ ...fix, kind }).unsupportedReason);
  }
});

test("crafted JSON, top-k from a title, and a stored change read back strictly", () => {
  assert.deepEqual(
    parseCrafted(JSON.stringify({ name: "a_and_b", searchableDescription: "Do a and b." })),
    {
      name: "a_and_b",
      searchable: "Do a and b.",
      description: "Do a and b.",
      parameters: { type: "object", properties: {} },
      sources: [],
    },
  );
  assert.equal(parseCrafted("not json"), null);
  assert.equal(topKFromTitle("Return 3 results per search instead of 10"), 3);
  assert.equal(topKFromTitle("Merge two tools"), null);
  const parsed = parseChange({
    patches: { a: "x", b: 2 },
    hide: ["c", 4],
    topK: 2.7,
    add: [{ id: "n", name: "n", searchable: "s", replaces: ["a"] }, { id: 1 }],
  });
  assert.deepEqual(parsed.patches, { a: "x" });
  assert.deepEqual(parsed.hide, ["c"]);
  assert.equal(parsed.topK, 2);
  assert.equal(parsed.add.length, 1);
  assert.ok(parseChange(null).unsupportedReason);
  assert.equal(
    describeChange(change({ collapse: ["find_task", "assign_task"] }))[0],
    "Back-to-back calls to find_task, assign_task become one call.",
  );
});

/* - simulate ----------------------------------------------------------------- */

test("the window is what the agent saw: the served length, capped by its top-k", () => {
  assert.equal(windowOf({ hitIds: ["a", "b", "c"], topK: null }), 3);
  assert.equal(windowOf({ hitIds: ["a", "b", "c"], topK: 2 }), 2);
  assert.equal(windowOf({ hitIds: null, topK: null }), 5);
});

test("a retired tool leaves the list; what the run would call after is not known, so it isn't read", () => {
  const r = run([
    search(1, ["legacy_export", "lookup_order", "notify"]),
    call(2, "legacy_export"),
    call(3, "lookup_order"),
  ]);
  const retired = simulateRun(r, change({ hide: ["legacy_export"] }), null);
  assert.deepEqual(retired.after.firstList, ["lookup_order", "notify"]);
  assert.equal(retired.after.calls, null);
  assert.equal(retired.after.failed, null);
  assert.deepEqual(retired.before, recordedView(r));

  const merged = simulateRun(
    run([
      search(1, ["find_task", "assign_task", "notify"]),
      call(2, "find_task"),
      call(3, "assign_task"),
    ]),
    change({
      hide: ["find_task", "assign_task"],
      add: [
        {
          id: "hand_over",
          name: "hand_over",
          searchable: "x",
          replaces: ["find_task", "assign_task"],
        },
      ],
      collapse: ["find_task", "assign_task"],
    }),
    null,
  );
  assert.deepEqual(merged.after.firstList, ["hand_over", "notify"]);
  assert.equal(merged.after.calls, null);
});

test("fewer results cuts every list", () => {
  const r = run([search(1, ["a", "b", "c", "d", "e"]), call(2, "c")]);
  assert.deepEqual(simulateRun(r, change({ topK: 2 }), null).after.firstList, ["a", "b"]);
});

test("a rewrite re-ranks the ask on both sides with the same engine, and skips a run whose ask expired", () => {
  const ranker: Ranker = {
    before: () => ["notify", "lookup_order"],
    after: () => ["lookup_order", "notify"],
  };
  const patched = change({ patches: { lookup_order: "orders" } });
  const r = run([search(1, ["notify", "x"], "where is my order"), call(2, "lookup_order")]);
  const simulated = simulateRun(r, patched, ranker);
  assert.equal(simulated.reranked, true);
  assert.deepEqual(simulated.before.firstList, ["notify", "lookup_order"]);
  assert.deepEqual(simulated.after.firstList, ["lookup_order", "notify"]);
  assert.equal(
    simulateRun(run([search(1, ["notify"], null), call(2, "lookup_order")]), patched, ranker)
      .skipped,
    "query-expired",
  );
});

test("the SDK's BM25 ranks a rewritten tool first for the words it gained", () => {
  const corpus: CorpusEntry[] = [
    {
      entryId: "lookup_order",
      name: "lookup_order",
      searchable: "Look up an order by id.",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
    {
      entryId: "track_parcel",
      name: "track_parcel",
      searchable: "Track where a parcel is right now.",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
    {
      entryId: "notify",
      name: "notify",
      searchable: "Send a message to the owner.",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
  ];
  const patched = change({
    patches: { lookup_order: "Look up an order by id. Where is my order, order status, tracking." },
  });
  const ranker = createRanker(corpus, patched);
  assert.ok(ranker);
  assert.equal(ranker.after("where is my order status", 3)[0], "lookup_order");
  assert.equal(createRanker([], patched), null);
});

test("a run the change never touches is not affected", () => {
  const r = run([search(1, ["notify"]), call(2, "notify")]);
  assert.equal(affects(r, change({ collapse: ["find_task", "assign_task"] })), false);
  assert.equal(affects(r, change({ topK: 2 })), true);
});

/* - defaults ----------------------------------------------------------------- */

test("drafted expectations follow the fix's kind", () => {
  const r = run([
    search(1, ["find_task", "assign_task"]),
    call(2, "find_task"),
    call(3, "assign_task"),
    call(4, "notify"),
  ]);
  assert.equal(neededCalls(r, ["find_task", "assign_task"]), 2);
  const merge = defaultExpected(r, "merge", change({ collapse: ["find_task", "assign_task"] }), [
    "find_task",
    "assign_task",
  ]);
  assert.equal(merge.maxToolCalls, 2);
  // A replayed kind is also held to how the run ended (RC-61).
  assert.equal(merge.endsWell, true);
  assert.equal(merge.maxSelfCorrections, 0);
  assert.equal(
    defaultExpected(r, "prerequisite", change({ collapse: ["find_task", "assign_task"] }), [
      "find_task",
      "assign_task",
    ]).maxFailedCalls,
    0,
  );
  assert.equal(
    defaultExpected(r, "prerequisite", change({ collapse: ["find_task", "assign_task"] }), [
      "find_task",
      "assign_task",
    ]).maxToolCalls,
    null,
  );
  assert.deepEqual(defaultExpected(r, "retire", change({ hide: ["notify"] }), ["notify"]), {
    ...NO_EXPECTATION,
    tool: "find_task",
    avoidTools: ["notify"],
  });
  assert.equal(
    defaultExpected(r, "rewrite", change({ patches: { assign_task: "x" } }), ["assign_task"]).tool,
    "assign_task",
  );
  assert.equal(
    defaultExpected(r, "schema", change({ dedupeRetries: ["notify"] }), ["notify"]).maxFailedCalls,
    1,
  );
  assert.equal(wantedTool(run([call(1, "a", "error"), call(2, "b")]), []), "b");
  assert.equal(
    describeExpected({ ...NO_EXPECTATION, tool: "a", maxToolCalls: 2 }),
    "Finds a in the first list, at most 2 calls",
  );
  assert.deepEqual(
    parseExpected({ tool: " a ", maxToolCalls: -1, maxSearches: 2.5, avoidTools: ["x", "x", 3] }),
    { ...NO_EXPECTATION, tool: "a", maxSearches: 2, avoidTools: ["x"] },
  );
});

/* - score -------------------------------------------------------------------- */

test("the right-tool check is Quality's rank credit inside the window the agent saw", () => {
  const view: RunView = { firstList: ["a", "b", "c"], searches: 1, calls: ["b"], failed: 0 };
  const first = checkSide(view, { ...NO_EXPECTATION, tool: "a" }, null);
  const second = checkSide(view, { ...NO_EXPECTATION, tool: "b" }, null);
  const absent = checkSide(view, { ...NO_EXPECTATION, tool: "z" }, null);
  assert.equal(first.score, 1);
  assert.ok(second.score > 0.5 && second.score < 1);
  assert.equal(absent.pass, false);
  assert.equal(absent.score, 0);
  // A merge's stand-in counts as the tool it replaces, after the change.
  const merged = change({ add: [{ id: "ab", name: "ab", searchable: "x", replaces: ["b"] }] });
  assert.equal(
    checkSide({ ...view, firstList: ["ab"] }, { ...NO_EXPECTATION, tool: "b" }, merged).rank,
    1,
  );
});

test("a set reads better only when the paired interval clears zero", () => {
  const caseOf = (id: string) => ({
    id,
    turnId: id,
    expected: { ...NO_EXPECTATION, maxToolCalls: 2 },
  });
  const simulated = (beforeCalls: number, afterCalls: number) => ({
    before: { firstList: null, searches: 0, calls: Array(beforeCalls).fill("x"), failed: 0 },
    after: { firstList: null, searches: 0, calls: Array(afterCalls).fill("x"), failed: 0 },
    skipped: null,
    reranked: false,
  });
  const c = change({ collapse: ["x"] });
  const better = summarize(
    ["1", "2", "3", "4"].map((id) => scoreCase(caseOf(id), simulated(3, 1), c)),
    "seed",
  );
  assert.equal(better.verdict, "better");
  assert.deepEqual([better.before.passRate, better.after.passRate], [0, 1]);
  const same = summarize(
    ["1", "2", "3", "4"].map((id) => scoreCase(caseOf(id), simulated(1, 1), c)),
    "seed",
  );
  assert.equal(same.verdict, "same");
  const few = summarize([scoreCase(caseOf("1"), simulated(3, 1), c)], "seed");
  assert.equal(few.verdict, "too-few");
  const gone = scoreCase(caseOf("1"), null, c);
  assert.equal(gone.skipped, "run-gone");
  assert.equal(
    scoreCase({ ...caseOf("1"), expected: NO_EXPECTATION }, simulated(1, 1), c).skipped,
    "no-checks",
  );
  assert.equal(summarize([], "seed", true).verdict, "unsupported");
});

/* - view --------------------------------------------------------------------- */

test("the badge's words", () => {
  assert.equal(simulatedLabel(1), "Simulated on 1 historical run");
  assert.equal(simulatedLabel(24), "Simulated on 24 historical runs");
  assert.equal(
    passLine(
      { passed: 5, total: 8, passRate: 0.625, score: 0.6 },
      { passed: 7, total: 8, passRate: 0.875, score: 0.9 },
    ),
    "63% → 88%",
  );
  assert.equal(badgeSentence({ state: "none" }), "Not simulated yet");
  assert.equal(evalHref("p1", "craft:abc"), "/project/p1/improvement/fixes/craft%3Aabc/eval");
  assert.equal(fixIdFromSegment("craft%3Aabc"), "craft:abc");
  assert.equal(fixIdFromSegment("craft:abc"), "craft:abc");
});

test("the expected outcome uses the Finishes cleanly scorer label", () => {
  assert.equal(describeExpected({ ...NO_EXPECTATION, endsWell: true }), "Finishes cleanly");
});
