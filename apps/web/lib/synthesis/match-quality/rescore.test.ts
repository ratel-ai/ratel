import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplayCases } from "./labels";
import { REPLAY_CREDIT, replay } from "./replay";
import { corpusAtRun, isStaleBacktest, type RescoreProposal, rescoreRun } from "./rescore";
import type { CorpusEntry, EvalItem } from "./types";

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

function item(query: string, target: string, ours: string[], theirs: string[]): EvalItem {
  return {
    selectionId: `sel-${query}`,
    occurredAt: AT,
    query,
    targetEntryId: target,
    targetKind: "tool",
    targetSource: "judge",
    arms: [
      { arm: "ratel", role: "shadow", resultIds: ours, resultScores: null },
      { arm: "legacy", role: "serving", resultIds: theirs, resultScores: null },
    ],
  };
}

const CORPUS: CorpusEntry[] = [
  entry("ledger_op", "Handles ledger reversal operations."),
  entry("list_invoices", "Lists invoices for an account."),
  entry("cancel_subscription", "Cancels a subscription for an account."),
];

const HISTORY: EvalItem[] = [
  item("refund a payment", "ledger_op", ["list_invoices"], ["ledger_op"]),
  item("show my invoices", "list_invoices", ["list_invoices"], ["list_invoices"]),
];

const OLD_BLOB = { scorer: "bm25-replay", n: 2, discarded: 1 };

function proposal(overrides: Partial<RescoreProposal> = {}): RescoreProposal {
  return {
    id: "p1",
    entryId: "ledger_op",
    status: "pending",
    currentSearchable: "Handles ledger reversal operations.",
    proposedSearchable: "Refund a payment. Handles ledger reversal operations.",
    backtest: OLD_BLOB,
    ...overrides,
  };
}

const input = (proposals: RescoreProposal[], runBacktest: unknown = OLD_BLOB) => ({
  corpus: CORPUS,
  history: HISTORY,
  labels: new Map(),
  tunedArm: "ratel",
  baselineArm: "legacy",
  runBacktest,
  proposals,
});

test("a blob without the current credit marker is stale; null is not", () => {
  assert.equal(isStaleBacktest(OLD_BLOB), true);
  assert.equal(isStaleBacktest({ ...OLD_BLOB, credit: "something-older" }), true);
  assert.equal(isStaleBacktest({ ...OLD_BLOB, credit: REPLAY_CREDIT }), false);
  assert.equal(isStaleBacktest(null), false);
});

test("a stale run is re-scored to what a fresh replay of the same set gives", () => {
  const output = rescoreRun(input([proposal()]));
  const cases = buildReplayCases(HISTORY, new Map(), "ratel", "legacy");
  const expected = replay(CORPUS, cases, [
    { entryId: "ledger_op", searchableDescription: proposal().proposedSearchable },
  ]);

  assert.equal(output.runBacktest?.credit, REPLAY_CREDIT);
  assert.deepEqual(
    { ...output.runBacktest, discarded: undefined },
    { ...expected, discarded: undefined },
  );
  // The stored count of discarded drafts has no replay behind it, so it is kept.
  assert.equal(output.runBacktest?.discarded, 1);
  assert.deepEqual(output.proposalBacktests.get("p1"), expected);
  // The rewrite actually helps its own search, so the number is real, not zero.
  assert.ok(output.runBacktest!.delta.containment > 0);
});

test("results already on the current curve are left alone", () => {
  const current = { ...OLD_BLOB, credit: REPLAY_CREDIT };
  const output = rescoreRun(input([proposal({ backtest: current })], current));
  assert.equal(output.runBacktest, null);
  assert.equal(output.proposalBacktests.size, 0);
});

test("an applied proposal is replayed against the text it was drafted over", () => {
  const applied = proposal({ status: "applied" });
  // Today's corpus already carries the rewrite.
  const today = CORPUS.map((row) =>
    row.entryId === "ledger_op" ? { ...row, searchable: applied.proposedSearchable } : row,
  );
  const output = rescoreRun({ ...input([applied]), corpus: today });
  // Against today's corpus the patch would be a no-op; restored, it is a gain.
  assert.ok(output.proposalBacktests.get("p1")!.delta.containment > 0);
});

test("corpusAtRun only restores applied rewrites", () => {
  const restored = corpusAtRun(
    [entry("ledger_op", "NEW"), entry("list_invoices", "same")],
    [
      proposal({ status: "applied", currentSearchable: "OLD" }),
      proposal({ id: "p2", entryId: "list_invoices", status: "dismissed", currentSearchable: "x" }),
    ],
  );
  assert.deepEqual(
    restored.map((row) => row.searchable),
    ["OLD", "same"],
  );
});

test("with nothing left to replay, stale numbers are cleared rather than kept", () => {
  const output = rescoreRun({ ...input([proposal()]), history: [] });
  assert.equal(output.runBacktest, null);
  assert.equal(output.proposalBacktests.get("p1"), null);
});
