import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplayCase } from "./replay";
import {
  bootstrapInterval,
  classifyMovement,
  MAX_REPLAY_CASES,
  replay,
  thinCases,
  windowFor,
} from "./replay";
import type { CorpusEntry } from "./types";

const AT = new Date("2026-09-10T12:00:00Z");

function entry(entryId: string, searchable: string): CorpusEntry {
  return {
    entryId,
    name: entryId,
    searchable,
    source: "runtime",
    matchesAgentDescription: true,
    tags: [],
  };
}

function testCase(query: string, target: string, opts: Partial<ReplayCase> = {}): ReplayCase {
  return {
    queryKey: query.toLowerCase(),
    query,
    targetEntryId: target,
    source: "invoked",
    servedIds: null,
    baselineIds: null,
    occurredAt: AT,
    ...opts,
  };
}

const CORPUS: CorpusEntry[] = [
  entry("refund_payment", "Handles ledger reversal operations."),
  entry("list_invoices", "Lists invoices for an account."),
  entry("cancel_subscription", "Cancels a subscription for an account."),
  entry("create_task", "Creates a task."),
];

/* — movement classification ------------------------------------------------- */

test("classifyMovement names each of the five outcomes", () => {
  assert.equal(classifyMovement(null, 1), "found");
  assert.equal(classifyMovement(3, null), "lost");
  assert.equal(classifyMovement(5, 2), "promoted");
  assert.equal(classifyMovement(2, 5), "demoted");
  assert.equal(classifyMovement(4, 4), "unchanged");
  assert.equal(classifyMovement(null, null), "unchanged");
});

/* — the replay itself ------------------------------------------------------- */

test("a rewrite that adopts the user's words lifts quality and reports the gain", () => {
  const cases = [
    testCase("give the customer their money back", "refund_payment"),
    testCase("refund this charge please", "refund_payment"),
  ];

  const result = replay(CORPUS, cases, [
    {
      entryId: "refund_payment",
      searchableDescription:
        "Reverses a charge. Use when the customer wants their money back, or asks to refund a payment.",
    },
  ]);

  assert.equal(result.scorer, "bm25-replay");
  assert.equal(result.n, 2);
  assert.ok(result.after.quality! > result.before.quality!);
  assert.ok(result.delta.quality > 0);
  // "refund this charge please" already matched the entry's NAME, so the gain
  // there is placement rather than coverage; the phrasing sharing no vocabulary
  // with the old text is the one that was missing entirely.
  assert.equal(result.movements.found, 1);
  assert.equal(result.movements.lost, 0);
  assert.equal(result.byEntry[0]?.entryId, "refund_payment");
  assert.equal(result.byEntry[0]?.patched, true);
  // The tool's own in-list counts, which its proposal card leads with.
  assert.equal(result.byEntry[0]?.n, 2);
  assert.equal(result.byEntry[0]?.containedBefore, 1);
  assert.equal(result.byEntry[0]?.containedAfter, 2);
});

test("a patched entry is kept in byEntry even when nothing moved", () => {
  const result = replay(
    CORPUS,
    [testCase("list my invoices", "list_invoices")],
    [{ entryId: "create_task", searchableDescription: "Creates a task in a project." }],
  );
  const patched = result.byEntry.find((row) => row.entryId === "create_task");
  // No search wanted create_task, so there is no row for it to keep; the
  // unmoved entry that WAS searched for is not patched and stays out.
  assert.equal(patched, undefined);
  assert.equal(
    result.byEntry.some((row) => row.entryId === "list_invoices"),
    false,
  );

  const own = replay(
    CORPUS,
    [testCase("list my invoices", "list_invoices")],
    [{ entryId: "list_invoices", searchableDescription: "Lists invoices for an account." }],
  );
  const row = own.byEntry.find((effect) => effect.entryId === "list_invoices");
  assert.ok(row, "patched and unmoved, but still reported");
  assert.equal(row.delta, 0);
  assert.equal(row.containedBefore, row.containedAfter);
});

test("the replay scores every labelled search, not only the patched entry's own", () => {
  const cases = [
    testCase("refund the customer", "refund_payment"),
    testCase("show me the invoices", "list_invoices"),
    testCase("cancel their subscription", "cancel_subscription"),
  ];

  const result = replay(CORPUS, cases, [
    { entryId: "refund_payment", searchableDescription: "Refunds a payment." },
  ]);

  // This is the whole point of a replay over a spot-check: the population is
  // the labelled set, so collateral movement on OTHER entries is visible.
  assert.equal(result.n, 3);
  assert.equal(result.before.n, 3);
  assert.equal(result.after.n, 3);
});

test("collateral damage on an unpatched entry is attributed to that entry", () => {
  const cases = [
    testCase("cancel the subscription for this account", "cancel_subscription"),
    testCase("refund them", "refund_payment"),
  ];

  // A greedy rewrite that swallows another entry's vocabulary.
  const result = replay(CORPUS, cases, [
    {
      entryId: "refund_payment",
      searchableDescription:
        "Refund. Cancel the subscription for this account, cancel subscription account cancel.",
    },
  ]);

  const collateral = result.byEntry.find((row) => row.entryId === "cancel_subscription");
  assert.ok(collateral, "the entry that lost ground should appear in byEntry");
  assert.ok(collateral.delta < 0, "its credit should have fallen");
});

test("a case whose target has left the corpus is dropped rather than scored as a miss", () => {
  const cases = [
    testCase("refund the customer", "refund_payment"),
    testCase("do the thing", "deleted_tool"),
  ];

  const result = replay(CORPUS, cases, []);
  assert.equal(result.n, 1);
  assert.equal(result.droppedUnknownTarget, 1);
});

test("duplicate phrasings of one query are replayed once", () => {
  const cases = [
    testCase("Refund The Customer", "refund_payment", { queryKey: "refund the customer" }),
    testCase("refund the customer", "refund_payment", { queryKey: "refund the customer" }),
    testCase("refund  the   customer ", "refund_payment", { queryKey: "refund the customer" }),
  ];
  const result = replay(CORPUS, cases, []);
  assert.equal(result.n, 1);
});

test("with no patches the before and after scores are identical and the delta is zero", () => {
  const cases = [
    testCase("refund the customer", "refund_payment"),
    testCase("list the invoices", "list_invoices"),
  ];
  const result = replay(CORPUS, cases, []);

  assert.equal(result.before.quality, result.after.quality);
  assert.equal(result.delta.quality, 0);
  assert.equal(result.delta.significant, false);
  assert.equal(result.movements.unchanged, 2);
});

test("the baseline arm is scored over the same labelled set from its recorded lists", () => {
  const cases = [
    testCase("refund the customer", "refund_payment", {
      baselineIds: ["refund_payment", "list_invoices"],
    }),
    testCase("list the invoices", "list_invoices", {
      baselineIds: ["cancel_subscription"],
    }),
  ];

  const result = replay(CORPUS, cases, []);
  assert.ok(result.baseline);
  assert.equal(result.baseline.n, 2);
  // One target at rank 1, one absent.
  assert.equal(result.baseline.contained, 1);
  assert.equal(result.baseline.containment, 0.5);
});

test("the baseline line is absent when no case recorded the baseline's list", () => {
  const result = replay(CORPUS, [testCase("refund the customer", "refund_payment")], []);
  assert.equal(result.baseline, null);
});

test("reproduction is measured against what our arm actually served", () => {
  const cases = [
    testCase("refund the customer", "refund_payment", { servedIds: ["refund_payment"] }),
    testCase("list the invoices", "list_invoices", { servedIds: ["cancel_subscription"] }),
  ];
  const result = replay(CORPUS, cases, []);

  assert.equal(result.reproductionSample, 2);
  assert.ok(result.reproductionRate !== null);
  assert.ok(result.reproductionRate >= 0 && result.reproductionRate <= 1);
});

test("the evidence mix of the replayed population travels with the result", () => {
  const cases = [
    testCase("refund the customer", "refund_payment", { source: "invoked" }),
    testCase("list the invoices", "list_invoices", { source: "judge" }),
    testCase("cancel it", "cancel_subscription", { source: "reference" }),
  ];
  const result = replay(CORPUS, cases, []);

  assert.deepEqual(result.evidence, { invoked: 1, judged: 1, assumed: 1 });
});

/* — the error bar ----------------------------------------------------------- */

test("a paired bootstrap over identical deltas has a zero-width interval", () => {
  const interval = bootstrapInterval([0.5, 0.5, 0.5, 0.5], "seed");
  assert.equal(interval.low, 0.5);
  assert.equal(interval.high, 0.5);
});

test("a paired bootstrap straddles zero when the deltas cancel out", () => {
  const interval = bootstrapInterval([1, -1, 1, -1, 1, -1, 1, -1], "seed");
  assert.ok(interval.low < 0, "lower bound should sit below zero");
  assert.ok(interval.high > 0, "upper bound should sit above zero");
});

test("a paired bootstrap is deterministic for the same seed", () => {
  const deltas = [0.2, -0.1, 0.4, 0.05, -0.3, 0.6, 0.1, 0.0, 0.25, -0.05];
  assert.deepEqual(bootstrapInterval(deltas, "run-a"), bootstrapInterval(deltas, "run-a"));
});

test("an empty or single-item population has no interval to report", () => {
  assert.deepEqual(bootstrapInterval([], "seed"), { low: 0, high: 0 });
});

test("a consistent, one-sided gain is called significant", () => {
  const cases = Array.from({ length: 40 }, (_, index) =>
    testCase(`give the customer their money back ${index}`, "refund_payment"),
  );
  const result = replay(CORPUS, cases, [
    {
      entryId: "refund_payment",
      searchableDescription:
        "Reverses a charge. Use when the customer wants their money back or asks for a refund.",
    },
  ]);

  assert.ok(result.delta.quality > 0);
  assert.equal(result.delta.significant, true);
  assert.ok(result.delta.interval.low > 0);
});

/* — the cap ----------------------------------------------------------------- */

test("an oversized population is thinned across its span, not truncated to its head", () => {
  const rows = Array.from({ length: 100 }, (_, index) => index);
  const thinned = thinCases(rows, 10);

  assert.equal(thinned.length, 10);
  assert.equal(thinned[0], 0);
  // A truncation would end at 9; a stride reaches the far end of the span.
  assert.ok(thinned[thinned.length - 1] >= 90);
});

test("a population inside the cap is returned whole", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(thinCases(rows, 10), rows);
});

test("the replay reports when the cap bound its population", () => {
  const many = Array.from({ length: MAX_REPLAY_CASES + 10 }, (_, index) =>
    testCase(`refund the customer number ${index}`, "refund_payment"),
  );
  const result = replay(CORPUS, many, []);

  assert.equal(result.truncated, true);
  assert.equal(result.n, MAX_REPLAY_CASES);
});

/* — surviving a real catalog ------------------------------------------------- */

test("an entry with no searchable text is skipped rather than crashing the replay", () => {
  // Not hypothetical: a runtime catalog can hold a tool synced with no
  // description, and the native registry rejects one outright.
  const corpus = [
    ...CORPUS,
    entry("legacy_metrics_export", ""),
    entry("internal_webhook_replay", "   "),
  ];

  const result = replay(corpus, [testCase("refund the customer", "refund_payment")], []);
  assert.equal(result.n, 1);
  assert.equal(result.before.n, 1);
});

test("a patch that blanks an entry's text is skipped rather than crashing", () => {
  const result = replay(
    CORPUS,
    [testCase("refund the customer", "refund_payment")],
    [{ entryId: "refund_payment", searchableDescription: "  " }],
  );
  // Blanked out of the index, so the target can no longer be found at all. That
  // is a real, scoreable outcome rather than an exception.
  assert.equal(result.movements.lost + result.movements.unchanged, 1);
});

test("an entry with no name is skipped too", () => {
  const nameless: CorpusEntry = { ...entry("x", "some text here"), name: "" };
  const result = replay(
    [...CORPUS, nameless],
    [testCase("refund the customer", "refund_payment")],
    [],
  );
  assert.equal(result.n, 1);
});

/* — the window each search is judged in -------------------------------------- */

test("a search is judged inside the list it actually returned, not a fixed depth", () => {
  assert.equal(windowFor(["a", "b", "c"]), 3);
  assert.equal(windowFor(["a"]), 1);
  // Nothing recorded, so there is no observed window to use.
  assert.equal(windowFor(null), 5);
  assert.equal(windowFor([]), 5);
});

test("a tool below the agent's own window does not count as found", () => {
  const corpus = [
    entry("refund_payment", "Handles ledger reversal operations for a charge."),
    entry("list_invoices", "Lists invoices for an account."),
    entry("cancel_subscription", "Cancels a subscription for an account."),
    entry("create_task", "Creates a task."),
  ];
  // The agent was shown ONE result. Anything the replay ranks second is
  // something it never saw, and crediting it would flatter the catalog.
  const narrow = replay(
    corpus,
    [testCase("lists invoices for an account", "cancel_subscription", { servedIds: ["x"] })],
    [],
  );
  assert.equal(narrow.before.containment, 0);
  assert.equal(narrow.averageWindow, 1);

  // The same search with a five-result window can reach it.
  const wide = replay(
    corpus,
    [
      testCase("lists invoices for an account", "cancel_subscription", {
        servedIds: ["a", "b", "c", "d", "e"],
      }),
    ],
    [],
  );
  assert.equal(wide.averageWindow, 5);
  assert.ok((wide.before.containment ?? 0) >= (narrow.before.containment ?? 0));
});

test("the interval measures containment, which is what the headline prints", () => {
  // Every search gains the tool, so a containment interval must sit at +1 and
  // exclude zero. An interval drawn over rank credit would land lower.
  const cases = Array.from({ length: 30 }, (_unused, index) =>
    testCase(`give the customer their money back ${index}`, "refund_payment", {
      servedIds: ["list_invoices", "create_task", "cancel_subscription"],
    }),
  );
  const result = replay(CORPUS, cases, [
    {
      entryId: "refund_payment",
      searchableDescription:
        "Reverses a charge. Use when the customer wants their money back or asks for a refund.",
    },
  ]);

  assert.equal(result.delta.containment, 1);
  assert.equal(result.delta.interval.low, 1);
  assert.equal(result.delta.interval.high, 1);
  assert.equal(result.delta.significant, true);
});

test("both sides of a patch are judged in the same window", () => {
  const cases = [testCase("refund the customer", "refund_payment", { servedIds: ["a", "b"] })];
  const result = replay(CORPUS, cases, [
    { entryId: "refund_payment", searchableDescription: "Refunds a payment for a customer." },
  ]);
  // Paired: one window per search, used for the before and the after alike, so
  // the comparison can never be an artefact of measuring them differently.
  assert.equal(result.averageWindow, 2);
});
