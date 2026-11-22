import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLabels,
  buildReplayCases,
  type GroundTruthLabel,
  harvestLabels,
  labelledShare,
  mergeLabel,
  queryKey,
} from "./labels";
import type { EvalItem, TargetSource } from "./types";

const EARLY = new Date("2026-08-01T09:00:00Z");
const LATE = new Date("2026-09-10T12:00:00Z");

function label(overrides: Partial<GroundTruthLabel> = {}): GroundTruthLabel {
  return {
    queryKey: "refund the customer",
    query: "refund the customer",
    entryId: "refund_payment",
    source: "judge",
    confident: true,
    model: "claude-sonnet-5",
    selectionId: "s1",
    occurrences: 1,
    observedAt: EARLY,
    ...overrides,
  };
}

function item(
  selectionId: string,
  query: string | null,
  target: string,
  source: TargetSource,
  opts: { at?: Date; ours?: string[]; theirs?: string[] } = {},
): EvalItem {
  return {
    selectionId,
    occurredAt: opts.at ?? LATE,
    query,
    targetEntryId: target,
    targetKind: "tool",
    targetSource: source,
    arms: [
      {
        arm: "ratel",
        role: "serving",
        resultIds: opts.ours ?? ["list_invoices"],
        resultScores: null,
      },
      { arm: "legacy", role: "shadow", resultIds: opts.theirs ?? [target], resultScores: null },
    ],
  };
}

/* — the key ------------------------------------------------------------------ */

test("the query key folds case and collapses whitespace", () => {
  assert.equal(queryKey("  Refund   The\tCustomer "), "refund the customer");
  assert.equal(queryKey("refund the customer"), queryKey("REFUND THE CUSTOMER"));
});

test("an empty or whitespace-only query has no key", () => {
  assert.equal(queryKey(""), null);
  assert.equal(queryKey("   "), null);
  assert.equal(queryKey(null), null);
});

/* — precedence --------------------------------------------------------------- */

test("behaviour beats an opinion: an invocation overwrites a judged label", () => {
  const existing = label({ source: "judge", entryId: "list_invoices" });
  const incoming = label({ source: "invoked", entryId: "refund_payment", observedAt: LATE });

  const merged = mergeLabel(existing, incoming);
  assert.equal(merged.source, "invoked");
  assert.equal(merged.entryId, "refund_payment");
});

test("a judged label never overwrites an observed invocation", () => {
  const existing = label({ source: "invoked", entryId: "refund_payment" });
  const incoming = label({ source: "judge", entryId: "list_invoices", observedAt: LATE });

  const merged = mergeLabel(existing, incoming);
  assert.equal(merged.source, "invoked");
  assert.equal(merged.entryId, "refund_payment");
});

test("a newer judgment replaces an older one", () => {
  const existing = label({ source: "judge", entryId: "list_invoices", observedAt: EARLY });
  const incoming = label({ source: "judge", entryId: "refund_payment", observedAt: LATE });

  assert.equal(mergeLabel(existing, incoming).entryId, "refund_payment");
});

test("an older judgment arriving late does not overwrite a newer one", () => {
  const existing = label({ source: "judge", entryId: "refund_payment", observedAt: LATE });
  const incoming = label({ source: "judge", entryId: "list_invoices", observedAt: EARLY });

  assert.equal(mergeLabel(existing, incoming).entryId, "refund_payment");
});

test("every sighting adds to the occurrence count, whichever answer wins", () => {
  const existing = label({ occurrences: 4 });
  const merged = mergeLabel(existing, label({ observedAt: LATE }));
  assert.equal(merged.occurrences, 5);
});

test("the first sighting is kept whole when there is nothing to merge with", () => {
  const merged = mergeLabel(null, label());
  assert.equal(merged.entryId, "refund_payment");
  assert.equal(merged.occurrences, 1);
});

/* — harvesting --------------------------------------------------------------- */

test("only observed behaviour is harvested from items; verdicts and assumptions are not", () => {
  const items = [
    item("s1", "refund the customer", "refund_payment", "invoked"),
    item("s2", "show the invoices", "list_invoices", "judge"),
    item("s3", "cancel it", "cancel_subscription", "reference"),
  ];

  const harvested = harvestLabels(items);
  assert.deepEqual(
    harvested.map((row) => [row.entryId, row.source, row.model]),
    [["refund_payment", "invoked", null]],
  );
});

test("a search with no query text cannot be labelled", () => {
  assert.equal(harvestLabels([item("s1", null, "refund_payment", "invoked")]).length, 0);
});

test("repeated phrasings of one query harvest a single label", () => {
  const harvested = harvestLabels([
    item("s1", "Refund the customer", "refund_payment", "invoked"),
    item("s2", "refund  the customer", "refund_payment", "invoked"),
  ]);
  assert.equal(harvested.length, 1);
  assert.equal(harvested[0]?.occurrences, 2);
});

/* — applying the key to a run's own items ------------------------------------ */

test("a stored label promotes an assumed item off the reference tier", () => {
  const items = [item("s1", "refund the customer", "list_invoices", "reference")];
  const labels = new Map([["refund the customer", label({ entryId: "refund_payment" })]]);

  const [promoted] = applyLabels(items, labels);
  assert.equal(promoted?.targetEntryId, "refund_payment");
  assert.equal(promoted?.targetSource, "judge");
});

test("this run's own invocation outranks a label from another sighting", () => {
  const items = [item("s1", "refund the customer", "refund_payment", "invoked")];
  const labels = new Map([
    ["refund the customer", label({ entryId: "list_invoices", source: "judge" })],
  ]);

  const [untouched] = applyLabels(items, labels);
  assert.equal(untouched?.targetEntryId, "refund_payment");
  assert.equal(untouched?.targetSource, "invoked");
});

test("an invoked label carries its own strength onto the promoted item", () => {
  const items = [item("s1", "refund the customer", "list_invoices", "reference")];
  const labels = new Map([
    ["refund the customer", label({ entryId: "refund_payment", source: "invoked" })],
  ]);

  assert.equal(applyLabels(items, labels)[0]?.targetSource, "invoked");
});

test("an empty key leaves every item exactly as it was", () => {
  const items = [item("s1", "refund the customer", "list_invoices", "reference")];
  assert.deepEqual(applyLabels(items, new Map()), items);
});

test("promoted items are no longer visible to the judge's sampler", () => {
  // The sampler draws only from `reference`, so this is the mechanism by which a
  // run spends its judging budget on requests nobody has decided yet.
  const items = [
    item("s1", "refund the customer", "list_invoices", "reference"),
    item("s2", "a brand new question", "create_task", "reference"),
  ];
  const labels = new Map([["refund the customer", label({ entryId: "refund_payment" })]]);

  const applied = applyLabels(items, labels);
  assert.equal(applied.filter((row) => row.targetSource === "reference").length, 1);
  assert.equal(applied.find((row) => row.targetSource === "reference")?.selectionId, "s2");
});

/* — building the replay population ------------------------------------------- */

test("a stored label upgrades an assumed target in the frozen history", () => {
  const items = [item("s1", "refund the customer", "list_invoices", "reference")];
  const labels = new Map([
    ["refund the customer", label({ entryId: "refund_payment", source: "judge" })],
  ]);

  const [replayCase] = buildReplayCases(items, labels, "ratel", "legacy");
  assert.equal(replayCase?.targetEntryId, "refund_payment");
  assert.equal(replayCase?.source, "judge");
});

test("a search with no real answer is left out of the replay, not scored against a guess", () => {
  const items = [item("s1", "cancel it", "cancel_subscription", "reference")];
  assert.deepEqual(buildReplayCases(items, new Map(), "ratel", "legacy"), []);
});

test("an unclear label is no answer: the search stays out", () => {
  const items = [item("s1", "cancel it", "cancel_subscription", "reference")];
  const key = new Map([
    [
      "cancel it",
      {
        queryKey: "cancel it",
        query: "cancel it",
        entryId: "",
        source: "unclear" as const,
        confident: false,
        model: "jev",
        selectionId: "s1",
        occurrences: 1,
        observedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ],
  ]);
  assert.deepEqual(buildReplayCases(items, key, "ratel", "legacy"), []);
  assert.equal(applyLabels(items, key)[0]?.targetSource, "reference");
});

test("the arms are carried through so the replay can score the incumbent too", () => {
  const items = [
    item("s1", "refund the customer", "refund_payment", "invoked", {
      ours: ["list_invoices", "refund_payment"],
      theirs: ["refund_payment"],
    }),
  ];
  const [replayCase] = buildReplayCases(items, new Map(), "ratel", "legacy");

  assert.deepEqual(replayCase?.servedIds, ["list_invoices", "refund_payment"]);
  assert.deepEqual(replayCase?.baselineIds, ["refund_payment"]);
});

test("the newest sighting of a repeated query is the one replayed", () => {
  const items = [
    item("s2", "refund the customer", "refund_payment", "invoked", {
      at: LATE,
      ours: ["refund_payment"],
    }),
    item("s1", "refund the customer", "refund_payment", "invoked", {
      at: EARLY,
      ours: ["list_invoices"],
    }),
  ];

  const cases = buildReplayCases(items, new Map(), "ratel", "legacy");
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0]?.servedIds, ["refund_payment"]);
});

test("a search with no query text cannot be replayed", () => {
  assert.equal(
    buildReplayCases([item("s1", null, "x", "invoked")], new Map(), "ratel", "legacy").length,
    0,
  );
});

/* — the coverage figure the surface prints ----------------------------------- */

test("labelled share counts the searches standing on real evidence", () => {
  const cases = buildReplayCases(
    [
      item("s1", "a refund please", "refund_payment", "invoked"),
      item("s2", "the invoices", "list_invoices", "judge"),
      item("s3", "cancel it", "cancel_subscription", "reference"),
      item("s4", "something else", "create_task", "reference"),
    ],
    new Map(),
    "ratel",
    "legacy",
  );

  // The two unanswered searches are no longer in the population at all.
  assert.equal(cases.length, 2);
  assert.equal(labelledShare(cases), 1);
});

test("labelled share of an empty population is null, not zero", () => {
  assert.equal(labelledShare([]), null);
});

test("an older judged history row yields to a newer unclear verdict", () => {
  const history = [item("h1", "cancel it", "cancel_subscription", "judge")];
  const key = new Map([
    [
      "cancel it",
      {
        queryKey: "cancel it",
        query: "cancel it",
        entryId: "",
        source: "unclear" as const,
        confident: false,
        model: "jev",
        selectionId: "h1",
        occurrences: 1,
        observedAt: new Date("2026-09-20T00:00:00Z"),
      },
    ],
  ]);
  assert.deepEqual(buildReplayCases(history, key, "ratel", "legacy"), []);
});
