import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import type { QualitySelectionDiagnostics } from "@/lib/synthesis/quality/queries";
import { type PersistInput, type RunDeps, runMatchQuality, summariseQuality } from "./pipeline";
import type { CorpusEntry } from "./types";

const AT = new Date("2026-09-10T12:00:00Z");
const WINDOW = { since: new Date("2026-09-03T12:00:00Z"), until: new Date("2026-09-10T12:01:00Z") };
const PROJECT = "p1";

const CORPUS: CorpusEntry[] = [
  {
    entryId: "refund_payment",
    name: "refund_payment",
    searchable: "Reverses a ledger entry.",
    source: "runtime",
    matchesAgentDescription: true,
    tags: [],
  },
  {
    entryId: "list_invoices",
    name: "list_invoices",
    searchable: "Lists invoices for an account.",
    source: "runtime",
    matchesAgentDescription: true,
    tags: [],
  },
];

function diagnostics(): QualitySelectionDiagnostics {
  return {
    comparisonCount: 0,
    selectionCount: 0,
    invocationCount: 0,
    recordedRankCount: 0,
    attributionMode: "tool-id",
    rankedSelectionCount: 0,
    invokedToolKey: "ratel.experiment.invocation.tool_id",
    truncated: false,
  };
}

/** `count` searches where the agent ran refund_payment but we returned invoices. */
function losingSelections(count: number): EvaluableSelection[] {
  return Array.from({ length: count }, (_unused, index) => ({
    selectionId: `sel-${index}`,
    occurredAt: new Date(AT.getTime() - index * 60_000),
    query: `give the customer their money back ${index}`,
    invokedToolId: "refund_payment",
    invokedRank: null,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["refund_payment"], resultScores: null },
    ],
  }));
}

function deps(overrides: Partial<RunDeps> = {}, selections = losingSelections(30)) {
  const persisted: PersistInput[] = [];
  const base: RunDeps = {
    logError: () => {},
    loadSelections: async () => ({ selections, diagnostics: diagnostics() }),
    loadInvokedBySearchId: async () => new Map(),
    observeRetrieval: async () => ({ stages: ["bm25", "dense", "rrf"], topK: 5, samples: 30 }),
    loadCorpus: async () => ({ entries: CORPUS, fingerprint: "fp-1" }),
    persist: async (input) => {
      persisted.push(input);
    },
    ...overrides,
  };
  return { deps: base, persisted };
}

const OPTIONS = {
  projectId: PROJECT,
  projectName: "acme-mcp",
  experimentName: "mcp_search_operations",
  window: WINDOW,
};

test("a healthy window produces proposals with a preview and frozen evidence", async () => {
  const { deps: d, persisted } = deps({
    analyst: () => ({
      model: "test-model",
      complete: async () =>
        JSON.stringify({
          diagnosis: "refund_payment never says what a user would call it.",
          diagnosisPoints: [],
          proposals: [
            {
              entryId: "refund_payment",
              searchableDescription:
                "Refunds a payment. Use when the customer wants their money back.",
              rationale: "The losing queries all say money back.",
              expectedEffect: "refund_payment should win those searches.",
            },
          ],
        }),
    }),
  });

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.usedModel, true);
  assert.equal(outcome.proposalsCreated, 1);
  assert.equal(outcome.declinedReason, null);

  const [input] = persisted;
  assert.equal(input.items.length, 30);
  assert.equal(input.census.revealedN, 30);
  assert.equal(input.corpusFingerprint, "fp-1");
  assert.equal(input.model, "test-model");
  assert.equal(input.scorer, "bm25-spotcheck");
  assert.equal(input.proposals.length, 1);
  // The preview must carry its own error bar, not just a delta.
  assert.equal(input.proposals[0].preview.scorer, "bm25-spotcheck");
  assert.ok(input.proposals[0].preview.reproductionSample > 0);
  assert.equal(input.proposals[0].evidence.misses, 30);
});

test("a thin window declines before spending a model call", async () => {
  let called = false;
  const { deps: d, persisted } = deps(
    {
      analyst: () => ({
        model: "test-model",
        complete: async () => {
          called = true;
          return "{}";
        },
      }),
    },
    losingSelections(3),
  );

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(called, false);
  assert.equal(outcome.usedModel, false);
  assert.equal(outcome.proposalsCreated, 0);
  assert.match(outcome.declinedReason ?? "", /below the 20 needed/);
  // The census is still recorded, so the page can say what was missing.
  assert.equal(persisted[0].census.selectionsEvaluated, 3);
  assert.equal(persisted[0].items.length, 3);
});

test("a window where content capture is off declines and names the fix", async () => {
  const blind = losingSelections(30).map((selection) => ({ ...selection, query: null }));
  const { deps: d } = deps({ analyst: () => ({ model: "m", complete: async () => "{}" }) }, blind);
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.usedModel, false);
  assert.match(outcome.declinedReason ?? "", /content capture/);
});

test("no configured model still gathers and stores the evidence", async () => {
  const { deps: d, persisted } = deps({ analyst: undefined });
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.usedModel, false);
  assert.equal(outcome.candidatesFound, 1);
  assert.match(outcome.declinedReason ?? "", /No analysis model is configured/);
  assert.equal(persisted[0].items.length, 30);
  assert.equal(persisted[0].model, null);
});

test("a catalog we already rank perfectly declines with nothing to tune", async () => {
  const winning = losingSelections(30).map((selection) => ({
    ...selection,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["refund_payment"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["refund_payment"], resultScores: null },
    ],
  }));
  const { deps: d } = deps(
    { analyst: () => ({ model: "m", complete: async () => "{}" }) },
    winning,
  );
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.candidatesFound, 0);
  assert.match(outcome.declinedReason ?? "", /already returned first/);
});

test("a model that proposes nothing is a valid run, not a failure", async () => {
  const { deps: d, persisted } = deps({
    analyst: () => ({
      model: "m",
      complete: async () =>
        JSON.stringify({ diagnosis: "These descriptions are already tight.", proposals: [] }),
    }),
  });
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.usedModel, true);
  assert.equal(outcome.proposalsCreated, 0);
  assert.equal(persisted[0].diagnosis, "These descriptions are already tight.");
  assert.match(persisted[0].declinedReason ?? "", /proposed no changes/);
});

test("an invented entry id is dropped and reported rather than persisted", async () => {
  const { deps: d, persisted } = deps({
    analyst: () => ({
      model: "m",
      complete: async () =>
        JSON.stringify({
          diagnosis: "d",
          diagnosisPoints: [],
          proposals: [
            {
              entryId: "tool_that_does_not_exist",
              searchableDescription: "x",
              rationale: "r",
              expectedEffect: "e",
            },
          ],
        }),
    }),
  });
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.deepEqual(outcome.rejectedEntryIds, ["tool_that_does_not_exist"]);
  assert.equal(persisted[0].proposals.length, 0);
});

test("the trace-events lane is queried with the window's search ids", async () => {
  let sawIds: string[] = [];
  const { deps: d } = deps({
    loadInvokedBySearchId: async (_projectId, ids) => {
      sawIds = ids;
      return new Map();
    },
    analyst: () => ({
      model: "m",
      complete: async () => JSON.stringify({ diagnosis: "d", proposals: [] }),
    }),
  });
  await runMatchQuality(OPTIONS, d);
  assert.equal(sawIds.length, 30);
  assert.equal(sawIds[0], "sel-0");
});

test("the quality read names the gap driver only when the arms are comparable", () => {
  const selections = losingSelections(10);
  const comparable = summariseQuality(selections, {
    selectionsEvaluated: 10,
    revealedN: 10,
    referenceN: 0,
    judgedN: 0,
    queriesCaptured: 10,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: null,
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
  });
  assert.ok(comparable.lines.length > 0);
  assert.match(comparable.gapNote ?? "", /COVERAGE/);

  const notComparable = summariseQuality(selections, {
    selectionsEvaluated: 10,
    revealedN: 0,
    referenceN: 10,
    judgedN: 0,
    queriesCaptured: 10,
    truncated: false,
    attributionMode: "recorded-rank",
    invokedToolKey: null,
    revealedSource: "none",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
  });
  assert.equal(notComparable.gapNote, null);
});

test("a window with no selections at all declines without throwing", async () => {
  const { deps: d, persisted } = deps(
    { analyst: () => ({ model: "m", complete: async () => "{}" }) },
    [],
  );
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.census.selectionsEvaluated, 0);
  assert.equal(outcome.proposalsCreated, 0);
  assert.ok(outcome.declinedReason);
  assert.equal(persisted.length, 1);
});

/* — the backtest and the answer key ------------------------------------------ */

const REWRITE = {
  entryId: "refund_payment",
  // Additive, as a real analyst rewrite is: dropping the old wording would lose
  // the searches it was already winning, which the guard would then (correctly)
  // discard the rewrite for.
  searchableDescription:
    "Reverses a ledger entry. Refunds a payment. Use when the customer wants their money back.",
  rationale: "The losing queries all say money back.",
  expectedEffect: "refund_payment should win those searches.",
};

function analystReturning(proposals: unknown[]) {
  return () => ({
    model: "test-model",
    complete: async () => JSON.stringify({ diagnosis: "a read", diagnosisPoints: [], proposals }),
  });
}

test("a run replays the accumulated history and stores the portfolio result", async () => {
  const { deps: d, persisted } = deps({
    analyst: analystReturning([REWRITE]),
    loadHistory: async () => [],
    loadLabels: async () => new Map(),
  });

  await runMatchQuality(OPTIONS, d);
  const backtest = persisted[0].backtest;

  assert.ok(backtest, "a portfolio backtest should be attached to the run");
  assert.equal(backtest.scorer, "bm25-replay");
  // The population is this run's own frozen items when there is no older history.
  assert.equal(backtest.n, 30);
  assert.ok(backtest.after.quality! > backtest.before.quality!);
  assert.ok(backtest.delta.quality > 0);
});

test("the portfolio backtest reaches past this window into older frozen runs", async () => {
  const older = Array.from({ length: 12 }, (_unused, index) => ({
    selectionId: `old-${index}`,
    occurredAt: new Date(AT.getTime() - (index + 100) * 86_400_000),
    query: `issue a refund for this charge ${index}`,
    targetEntryId: "refund_payment",
    targetKind: "tool",
    targetSource: "invoked" as const,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["refund_payment"], resultScores: null },
    ],
  }));

  const { deps: d, persisted } = deps({
    analyst: analystReturning([REWRITE]),
    loadHistory: async () => older,
    loadLabels: async () => new Map(),
  });

  await runMatchQuality(OPTIONS, d);
  // 30 from this window plus 12 older ones, all distinct phrasings.
  assert.equal(persisted[0].backtest?.n, 42);
});

test("each proposal carries its own replay beside its spot-check", async () => {
  const { deps: d, persisted } = deps({
    analyst: analystReturning([REWRITE]),
    loadHistory: async () => [],
    loadLabels: async () => new Map(),
  });

  await runMatchQuality(OPTIONS, d);
  const [proposal] = persisted[0].proposals;

  // Both, not one or the other: they answer different questions.
  assert.equal(proposal.preview.scorer, "bm25-spotcheck");
  assert.equal(proposal.backtest?.scorer, "bm25-replay");
  assert.ok(proposal.backtest!.byEntry.length > 0);
});

test("a run harvests what it observed into the answer key", async () => {
  const { deps: d, persisted } = deps({
    analyst: analystReturning([REWRITE]),
    loadHistory: async () => [],
    loadLabels: async () => new Map(),
  });

  const outcome = await runMatchQuality(OPTIONS, d);
  // Thirty distinct phrasings, every one of them an observed invocation.
  assert.equal(outcome.labelsWritten, 30);
  assert.equal(persisted[0].labels.length, 30);
  assert.ok(persisted[0].labels.every((row) => row.source === "invoked"));
  assert.ok(persisted[0].labels.every((row) => row.model === null));
});

test("a stored label corrects an assumed target before candidates are picked", async () => {
  // No invocation recorded, so phase 1 would assume the baseline's pick was right.
  const selections = Array.from({ length: 30 }, (_unused, index) => ({
    selectionId: `sel-${index}`,
    occurredAt: new Date(AT.getTime() - index * 60_000),
    query: `give the customer their money back ${index}`,
    invokedToolId: null,
    invokedRank: null,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["list_invoices"], resultScores: null },
    ],
  }));

  const labels = new Map(
    selections.map((selection) => [
      selection.query.trim().toLowerCase(),
      {
        queryKey: selection.query.trim().toLowerCase(),
        query: selection.query,
        entryId: "refund_payment",
        source: "judge" as const,
        confident: true,
        model: "claude-sonnet-5",
        selectionId: selection.selectionId,
        occurrences: 1,
        observedAt: AT,
      },
    ]),
  );

  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([REWRITE]),
      loadHistory: async () => [],
      loadLabels: async () => labels,
    },
    selections,
  );

  const outcome = await runMatchQuality(OPTIONS, d);

  // The key moved every target off the incumbent's guess and onto the real answer.
  assert.equal(persisted[0].census.judgedN, 30);
  assert.equal(persisted[0].census.referenceN, 0);
  assert.equal(outcome.candidatesFound, 1);
  assert.equal(persisted[0].items[0].targetEntryId, "refund_payment");
});

test("a thin window still reports where the catalog stands over its whole history", async () => {
  const older = Array.from({ length: 25 }, (_unused, index) => ({
    selectionId: `old-${index}`,
    occurredAt: new Date(AT.getTime() - (index + 100) * 86_400_000),
    query: `issue a refund for this charge ${index}`,
    targetEntryId: "refund_payment",
    targetKind: "tool",
    targetSource: "invoked" as const,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["list_invoices"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["refund_payment"], resultScores: null },
    ],
  }));

  const { deps: d, persisted } = deps(
    { loadHistory: async () => older, loadLabels: async () => new Map() },
    // Below MIN_EVALUABLE_SEARCHES, so the run declines.
    losingSelections(4),
  );

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.ok(outcome.declinedReason, "a four-search window should still decline");

  // This is the point: declining to PROPOSE is not declining to MEASURE.
  const backtest = persisted[0].backtest;
  assert.ok(backtest, "a declined run should still report the standing quality");
  assert.equal(backtest.n, 29);
  assert.equal(backtest.delta.quality, 0);
  assert.ok(backtest.baseline, "and how the incumbent scores over the same set");
});

test("a run with no history to replay stores no backtest rather than an empty one", async () => {
  const { deps: d, persisted } = deps({
    analyst: analystReturning([REWRITE]),
    loadHistory: async () => [],
    loadLabels: async () => new Map(),
    loadSelections: async () => ({
      selections: losingSelections(30).map((row) => ({ ...row, query: null })),
      diagnostics: diagnostics(),
    }),
  });

  await runMatchQuality(OPTIONS, d);
  assert.equal(persisted[0].backtest, null);
});

test("with no history dep no replay runs at all, which is what the flag gates", async () => {
  const { deps: d, persisted } = deps({ analyst: analystReturning([REWRITE]) });

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.proposalsCreated, 1);
  assert.equal(persisted[0].labels.length, 30);
  // Unchanged: the spot-check still produces the preview and still names itself.
  assert.equal(persisted[0].scorer, "bm25-spotcheck");
  // The job omits `loadHistory` when the flag is off. Storing a backtest anyway
  // would make the gate a decoration.
  assert.equal(persisted[0].backtest, null);
  assert.equal(persisted[0].proposals[0].backtest ?? null, null);
});

/* — the quality guard --------------------------------------------------------- */

/**
 * Searches whose target IS already found, so a rewrite has something to break.
 *
 * `losingSelections` cannot show harm: its target is absent before the patch, so
 * a bad rewrite moves it from nowhere to nowhere and scores exactly zero. Harm
 * is only observable where the entry was being returned to begin with.
 */
function foundSelections(count: number): EvaluableSelection[] {
  return Array.from({ length: count }, (_unused, index) => ({
    selectionId: `sel-${index}`,
    occurredAt: new Date(AT.getTime() - index * 60_000),
    query: `reverses a ledger entry ${index}`,
    invokedToolId: "refund_payment",
    invokedRank: null,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["refund_payment"], resultScores: null },
      { arm: "legacy", role: "shadow" as const, resultIds: ["refund_payment"], resultScores: null },
    ],
  }));
}

/**
 * Half findable, half not.
 *
 * Both effects have to be observable in one population: a rewrite can only HELP
 * where its target is currently missed, and can only HARM where the target is
 * currently returned. A fixture of one kind alone can show only one of them.
 */
function mixedSelections(): EvaluableSelection[] {
  return [
    ...losingSelections(15),
    ...foundSelections(15).map((row, index) => ({
      ...row,
      selectionId: `found-${index}`,
    })),
  ];
}

/** A rewrite that only steals the neighbour's vocabulary: pure collateral. */
const HARMFUL = {
  entryId: "list_invoices",
  searchableDescription:
    "reverses a ledger entry ledger entry reverses reversal ledger reverses entry ledger",
  rationale: "a rewrite that swallows the neighbour's words",
  expectedEffect: "nothing good",
};

test("a rewrite the replay measures costing quality is not offered", async () => {
  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([REWRITE, HARMFUL]),
      loadHistory: async () => [],
      loadLabels: async () => new Map(),
    },
    mixedSelections(),
  );

  const outcome = await runMatchQuality(OPTIONS, d);

  assert.equal(outcome.proposalsCreated, 1, "only the rewrite that helps is offered");
  assert.equal(outcome.proposalsDiscarded, 1);

  // Deleted, not stored: nothing about the rejected rewrite is persisted.
  assert.deepEqual(
    persisted[0].proposals.map((row) => row.proposal.entryId),
    ["refund_payment"],
  );
});

test("a discarded rewrite is counted, not stored", async () => {
  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([HARMFUL]),
      loadHistory: async () => [],
      loadLabels: async () => new Map(),
    },
    mixedSelections(),
  );

  const outcome = await runMatchQuality(OPTIONS, d);

  // A rewrite the evidence has refused is not a suggestion, so nothing is
  // written: no row to browse, nothing anybody can apply later by mistake.
  assert.equal(persisted[0].proposals.length, 0);
  assert.equal(outcome.proposalsDiscarded, 1);
  // Only the count survives, on the blob the panel already reads.
  assert.equal((persisted[0].backtest as unknown as { discarded: number } | null)?.discarded, 1);
});

test("the portfolio headline describes only what is actually offered", async () => {
  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([REWRITE, HARMFUL]),
      loadHistory: async () => [],
      loadLabels: async () => new Map(),
    },
    mixedSelections(),
  );

  await runMatchQuality(OPTIONS, d);
  const portfolio = persisted[0].backtest;

  assert.ok(portfolio);
  // Had the discarded rewrite been folded in, the headline would promise a
  // number nobody can reach by clicking Apply.
  assert.ok(portfolio.delta.quality > 0);
  assert.deepEqual(
    portfolio.byEntry.filter((e) => e.patched).map((e) => e.entryId),
    ["refund_payment"],
  );
});

test("a run whose every draft measured worse says so instead of going quiet", async () => {
  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([HARMFUL]),
      loadHistory: async () => [],
      loadLabels: async () => new Map(),
    },
    mixedSelections(),
  );

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.proposalsCreated, 0);
  assert.equal(outcome.proposalsDiscarded, 1);
  assert.match(persisted[0].declinedReason ?? "", /measured none of them helping/);
});

/** A rewrite that repeats wording the tool already has: no search moves. */
const NEUTRAL = {
  entryId: "list_invoices",
  searchableDescription: "Lists invoices for an account. Lists invoices.",
  rationale: "a rewrite that changes nothing a search would notice",
  expectedEffect: "none",
};

test("a rewrite the replay measures changing nothing is not offered", async () => {
  const { deps: d, persisted } = deps(
    {
      analyst: analystReturning([REWRITE, NEUTRAL]),
      loadHistory: async () => [],
      loadLabels: async () => new Map(),
    },
    mixedSelections(),
  );

  const outcome = await runMatchQuality(OPTIONS, d);

  // "No change" beside an Apply button is not a suggestion.
  assert.equal(outcome.proposalsDiscarded, 1);
  assert.deepEqual(
    persisted[0].proposals.map((row) => row.proposal.entryId),
    ["refund_payment"],
  );
});

test("with no replay to judge them, every draft is offered exactly as before", async () => {
  // The flag off: no history dep, so no backtest, and absence of measurement
  // must never be read as evidence of harm.
  const { deps: d, persisted } = deps(
    { analyst: analystReturning([REWRITE, HARMFUL]) },
    mixedSelections(),
  );

  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(persisted[0].backtest, null);
  assert.equal(outcome.proposalsDiscarded, 0);
  assert.equal(outcome.proposalsCreated, 2);
});

/** Searches nobody observed or judged: ratel disagrees with legacy, no invocation. */
function unansweredSelections(count: number): EvaluableSelection[] {
  return losingSelections(count).map((selection) => ({ ...selection, invokedToolId: null }));
}

test("a search with no answer never nominates a rewrite, however much it disagrees", async () => {
  let analystCalled = false;
  const { deps: d, persisted } = deps(
    {
      analyst: () => {
        analystCalled = true;
        return { model: "test-model", complete: async () => "{}" };
      },
    },
    unansweredSelections(30),
  );
  const outcome = await runMatchQuality(OPTIONS, d);
  assert.equal(outcome.candidatesFound, 0);
  assert.equal(analystCalled, false);
  assert.equal(persisted[0]?.census.referenceN, 30);
});

test("the judge runs even on a window too thin to propose from, and its verdicts are stored", async () => {
  const { deps: d, persisted } = deps(
    {
      judge: {
        model: "jev-test",
        judge: async (cases) =>
          cases.map((row, index) => ({
            id: row.id,
            entryId: index === 0 ? "" : "refund_payment",
            confident: true,
          })),
      },
    },
    unansweredSelections(3),
  );
  await runMatchQuality(OPTIONS, d);
  const labels = persisted[0]?.labels ?? [];
  assert.equal(labels.length, 3);
  assert.equal(labels.filter((row) => row.source === "unclear").length, 1);
  assert.ok(labels.every((row) => typeof row.catalogFingerprint === "string"));
});

test("a request both judged and observed is written once, the observation winning", async () => {
  const selections = unansweredSelections(2).map((selection, index) =>
    index === 0
      ? { ...selection, query: "same request", invokedToolId: "refund_payment" }
      : { ...selection, query: "same request" },
  );
  const { deps: d, persisted } = deps(
    {
      judge: {
        model: "jev-test",
        judge: async (cases) =>
          cases.map((row) => ({ id: row.id, entryId: "list_invoices", confident: true })),
      },
    },
    selections,
  );
  await runMatchQuality(OPTIONS, d);
  const labels = persisted[0]?.labels ?? [];
  assert.equal(labels.filter((row) => row.queryKey === "same request").length, 1);
  assert.equal(labels.find((row) => row.queryKey === "same request")?.source, "invoked");
});

test("a run stores both engines' numbers against the key, including its own new verdicts", async () => {
  const { deps: d, persisted } = deps(
    {
      judge: {
        model: "jev-test",
        judge: async (cases) =>
          cases.map((row) => ({ id: row.id, entryId: "refund_payment", confident: true })),
      },
    },
    unansweredSelections(30),
  );
  await runMatchQuality(OPTIONS, d);
  const scores = persisted[0]?.scores as {
    arms: { arm: string; tier: string; top1?: number; n: number }[];
    answers: { answered: number; searches: number };
  };
  const judged = scores.arms.filter((line) => line.tier === "judged");
  assert.deepEqual(judged.map((line) => [line.arm, line.top1, line.n]).sort(), [
    ["legacy", 1, 30],
    ["ratel", 0, 30],
  ]);
  assert.deepEqual(scores.answers, { searches: 30, answered: 30, unclear: 0, unread: 0 });
});

/** Search telemetry: one engine (ratel), no calibration, no invocation. */
function searchOnlySelections(count: number): EvaluableSelection[] {
  return Array.from({ length: count }, (_unused, index) => ({
    selectionId: `search-${index}`,
    occurredAt: new Date(AT.getTime() - index * 60_000),
    query: `give the customer their money back ${index}`,
    invokedToolId: null,
    invokedRank: null,
    arms: [
      { arm: "ratel", role: "serving" as const, resultIds: ["list_invoices"], resultScores: null },
    ],
  }));
}

test("without a calibration, a run judges, measures, backtests and proposes from ratel alone", async () => {
  let analystSaw = 0;
  const { deps: d, persisted } = deps(
    {
      judge: {
        model: "jev-test",
        judge: async (cases) =>
          cases.map((row) => ({ id: row.id, entryId: "refund_payment", confident: true })),
      },
      loadLabels: async () => new Map(),
      loadHistory: async () => [],
      analyst: (context) => {
        analystSaw = context.candidates.length;
        return {
          model: "test-model",
          complete: async () =>
            JSON.stringify({ diagnosis: "", diagnosisPoints: [], proposals: [] }),
        };
      },
    },
    searchOnlySelections(30),
  );
  const outcome = await runMatchQuality(OPTIONS, d);
  const input = persisted[0]!;
  assert.equal(input.census.baselineArm, null);
  assert.equal(input.census.tunedArm, "ratel");
  assert.equal(input.labels.length, 30);
  const scores = input.scores as { arms: { arm: string; tier: string; top1?: number }[] };
  assert.deepEqual(
    scores.arms.filter((line) => line.tier === "judged").map((line) => [line.arm, line.top1]),
    [["ratel", 0]],
  );
  assert.equal(outcome.candidatesFound, 1);
  assert.equal(analystSaw, 1);
  assert.ok(input.backtest, "a backtest runs without a baseline");
});
