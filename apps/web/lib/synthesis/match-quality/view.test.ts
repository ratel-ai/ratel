import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import type { ProposalPreview } from "./types";
import {
  captureNote,
  censusFacts,
  formatGap,
  groupProposals,
  nextScheduledRun,
  previewView,
  proposalFailures,
  proposalImpact,
  qualityNumbers,
  runHeadline,
  runStatus,
  sourceLabel,
} from "./view";

const NOW = new Date("2026-09-14T12:00:00Z");

function run(overrides: Partial<MatchQualityRunRow> = {}): MatchQualityRunRow {
  return {
    id: "r1",
    projectId: "p1",
    experimentName: "mcp_search_operations",
    trigger: "scheduled",
    status: "analyzed",
    windowDays: 7,
    windowStart: NOW,
    windowEnd: NOW,
    selectionsEvaluated: 100,
    revealedN: 80,
    referenceN: 20,
    judgedN: 0,
    queriesCaptured: 100,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: "ratel.experiment.invocation.tool_id",
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
    followThrough: {},
    observedStages: {},
    scores: {},
    corpusFingerprint: "fp",
    model: "claude-sonnet-5",
    mocked: false,
    diagnosis: "d",
    diagnosisPoints: [],
    declinedReason: null,
    scorer: "bm25-spotcheck",
    refinementRounds: 0,
    error: null,
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    ...overrides,
  } as MatchQualityRunRow;
}

function preview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    scorer: "bm25-spotcheck",
    hits: [
      { query: "a", targetEntryId: "t", before: null, after: 1 },
      { query: "b", targetEntryId: "t", before: 4, after: 2 },
    ],
    improved: 2,
    worsened: 0,
    unchanged: 0,
    reproductionRate: 0.9,
    reproductionSample: 50,
    inconclusive: false,
    ...overrides,
  };
}

test("a live run keeps the page polling; a finished one does not", () => {
  assert.deepEqual(runStatus({ status: "queued" }), {
    phase: "queued",
    label: "Queued",
    live: true,
  });
  assert.equal(runStatus({ status: "running" }).live, true);
  assert.equal(runStatus({ status: "analyzed" }).live, false);
  assert.equal(runStatus({ status: "failed" }).live, false);
});

test("an unrecognised status reads as finished rather than polling forever", () => {
  assert.equal(runStatus({ status: "something-new" }).live, false);
});

test("an empty window is one fact, not six zeroes and two warnings", () => {
  const facts = censusFacts(
    run({ selectionsEvaluated: 0, revealedN: 0, referenceN: 0, queriesCaptured: 0 }),
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].value, "0");
  assert.match(facts[0].warning ?? "", /nothing to measure/);
  // The invoked-evidence warning would be about evidence that could not exist.
  assert.ok(!facts.some((fact) => /agreement with the baseline/.test(fact.warning ?? "")));
});

test("no invoked evidence is stated as a caveat, not omitted", () => {
  const facts = censusFacts(run({ revealedN: 0, referenceN: 100, attributionMode: "none" }));
  const revealed = facts.find((fact) => fact.label.includes("what the agent ran"));
  assert.match(revealed?.warning ?? "", /none has been decided yet, so there is nothing to score/);
});

test("full invoked evidence carries no warning", () => {
  const facts = censusFacts(run({ revealedN: 100, referenceN: 0 }));
  const revealed = facts.find((fact) => fact.label.includes("what the agent ran"));
  assert.equal(revealed?.warning, undefined);
});

test("partial content capture is called out with the shortfall", () => {
  const facts = censusFacts(run({ selectionsEvaluated: 100, queriesCaptured: 30 }));
  const captured = facts.find((fact) => fact.label.includes("query text"));
  assert.equal(captured?.value, "30 of 100");
  assert.match(captured?.warning ?? "", /Content capture is off/);
});

test("the census names the arm being tuned, not just the one that served", () => {
  const facts = censusFacts(run());
  const arms = facts.find((fact) => fact.label === "Arms");
  assert.equal(arms?.value, "tuning ratel against legacy; ratel served");
});

test("the tuned arm is named even when the incumbent is the one serving", () => {
  // The demo fixture routes it this way, and a reader needs to see that the
  // rewrites target our corpus rather than whichever side happened to serve.
  const facts = censusFacts(run({ servingArm: "legacy", tunedArm: "ratel" }));
  const arms = facts.find((fact) => fact.label === "Arms");
  assert.equal(arms?.value, "tuning ratel against legacy; legacy served");
});

test("the trace-events lane is named as the source when it answered", () => {
  const facts = censusFacts(run({ revealedSource: "trace-events" }));
  const source = facts.find((fact) => fact.label === "Invoked tools read from");
  assert.match(source?.value ?? "", /runtime facts, joined on search id/);
});

test("the chip is a few words; the reasoning moves to the tooltip", () => {
  const view = previewView(preview());
  assert.ok(view);
  assert.equal(view.chip, "2 of 2 better");
  assert.ok(view.chip.length < 24, "the chip has to fit on one line beside the proposal");
  assert.equal(view.tone, "improves");
  // The error rate is not dropped, only moved: a delta shown without it reads as
  // proof, and this check is nowhere near good enough to be proof.
  assert.match(view.detail, /reproduces the tool production actually served 90% of the time/);
  assert.match(view.detail, /not a backtest/);
  // The chip's own words are explained without the metric's vocabulary: a reader
  // meeting "2 of 2 better" should not have to know what a spot-check is first.
  assert.match(view.meaning, /We tried this rewrite on the 2 searches it lost/);
  assert.doesNotMatch(view.meaning, /BM25|spot-check|reproduc/i);
});

test("a preview with no measured accuracy says so in the detail", () => {
  const view = previewView(
    preview({ reproductionRate: null, reproductionSample: 0, inconclusive: true }),
  );
  assert.match(view?.detail ?? "", /no measured accuracy/);
  assert.equal(view?.tone, "inconclusive");
});

test("movement inside the margin of error reads as inconclusive, not as a win", () => {
  const view = previewView(preview({ improved: 1, worsened: 1, inconclusive: true }));
  assert.equal(view?.tone, "inconclusive");
  assert.equal(view?.chip, "Inconclusive");
  assert.match(view?.detail ?? "", /down on 1/);
  assert.match(view?.meaning ?? "", /did not move them enough to be sure/);
});

test("a proposal with nothing to check says that rather than claiming zero movement", () => {
  const view = previewView(preview({ hits: [], improved: 0, worsened: 0, inconclusive: true }));
  assert.equal(view?.chip, "Not checkable");
  assert.match(view?.detail ?? "", /none of the searches it lost stored their query text/);
  assert.match(view?.meaning ?? "", /stored the words that were typed/);
});

test("a malformed preview renders nothing rather than throwing", () => {
  assert.equal(previewView(null), null);
  assert.equal(previewView({}), null);
  assert.equal(previewView("nonsense"), null);
});

test("stored failures survive the round trip, and junk does not", () => {
  const failures = proposalFailures({
    failures: [
      { query: "q", ourRank: null, ourTop: "x", baselineTop: "y", targetSource: "invoked" },
      { nonsense: true },
    ],
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].query, "q");
  assert.deepEqual(proposalFailures(null), []);
  assert.deepEqual(proposalFailures({ failures: "nope" }), []);
});

test("the source of the current text is named in the catalog's own words", () => {
  assert.equal(sourceLabel("override"), "Cloud override");
  assert.equal(sourceLabel("runtime"), "Runtime default");
  assert.equal(sourceLabel("description"), "Same as the agent description");
});

test("superseded proposals are kept off the page entirely", () => {
  const rows = [
    { status: "pending" },
    { status: "applied" },
    { status: "dismissed" },
    { status: "reverted" },
    { status: "superseded" },
  ] as MatchQualityProposalRow[];
  const groups = groupProposals(rows);
  assert.equal(groups.pending.length, 1);
  assert.equal(groups.applied.length, 1);
  assert.equal(groups.resolved.length, 2);
  const shown = [...groups.pending, ...groups.applied, ...groups.resolved];
  assert.ok(!shown.some((row) => row.status === "superseded"));
});

/* — Headline, scheduling and impact ----------------------------------------- */

const LATER = new Date("2026-09-14T14:00:00Z");

test("the headline answers the reader, it does not name a machine state", () => {
  const head = runHeadline(run({ selectionsEvaluated: 40 }), 5, LATER);
  assert.equal(head.title, "5 rewrites from 40 searches");
  assert.doesNotMatch(head.title, /done/i);
  assert.match(head.detail, /7 day window/);
  assert.match(head.detail, /2 hours ago/);
  assert.match(head.detail, /claude-sonnet-5/);
});

test("a run that found nothing to change says so rather than reading as empty", () => {
  const head = runHeadline(run({ selectionsEvaluated: 40 }), 0, LATER);
  assert.equal(head.title, "Read 40 searches, nothing worth changing");
});

test("a run over an empty window is distinct from a run that found nothing", () => {
  const head = runHeadline(run({ selectionsEvaluated: 0 }), 0, LATER);
  assert.equal(head.title, "Nothing to measure in that window");
});

test("a mocked run names no model, and does not narrate the mock either", () => {
  // The header prints a "Mock data" chip; the detail line repeating it would be a
  // second statement of the same fact in the row under it.
  const head = runHeadline(run({ mocked: true, model: "mock-analyst-local" }), 1, LATER);
  assert.doesNotMatch(head.detail, /mock-analyst-local/);
  assert.doesNotMatch(head.detail, /stand-in/);
  assert.equal(head.detail, "7 day window · 2 hours ago");
});

test("a live run reads as in progress and keeps the page polling", () => {
  assert.deepEqual(
    (({ title, live }) => ({ title, live }))(runHeadline(run({ status: "running" }), 0, LATER)),
    { title: "Reading your searches", live: true },
  );
  assert.equal(runHeadline(run({ status: "queued" }), 0, LATER).live, true);
});

test("a failed run leads with the failure, not with a count", () => {
  const head = runHeadline(run({ status: "failed", error: "connection reset" }), 0, LATER);
  assert.equal(head.title, "That run did not finish");
  assert.equal(head.detail, "connection reset");
});

test("with no run at all the header invites one", () => {
  const head = runHeadline(null, 0, LATER);
  assert.equal(head.title, "Not analysed yet");
  assert.match(head.detail, /each week/);
});

test("the next scheduled run is a week after the last one started", () => {
  const started = new Date("2026-09-14T12:00:00Z");
  const due = nextScheduledRun(run({ createdAt: started }), LATER);
  assert.equal(due?.toISOString(), "2026-09-21T12:00:00.000Z");
});

test("an overdue or in-flight run has no future date to promise", () => {
  const old = new Date("2026-08-01T12:00:00Z");
  assert.equal(nextScheduledRun(run({ createdAt: old }), LATER), null);
  assert.equal(nextScheduledRun(run({ status: "running" }), LATER), null);
  assert.equal(nextScheduledRun(null, LATER), null);
});

test("the gap reads in the largest unit that still says something", () => {
  const base = new Date("2026-09-14T12:00:00Z");
  assert.equal(formatGap(base, new Date("2026-09-14T12:30:00Z")), "30 minutes");
  assert.equal(formatGap(base, new Date("2026-09-14T13:00:00Z")), "1 hour");
  assert.equal(formatGap(base, new Date("2026-09-16T12:00:00Z")), "2 days");
  assert.equal(formatGap(base, new Date("2026-09-21T12:00:00Z")), "7 days");
});

function withEvidence(
  misses: number,
  buried: number,
  entryName = "t",
  status = "pending",
): MatchQualityProposalRow {
  return { entryName, status, evidence: { misses, buried } } as unknown as MatchQualityProposalRow;
}

test("a row leads with a count of real events, phrased for what happened", () => {
  assert.equal(proposalImpact(withEvidence(3, 0)).label, "missed on 3 searches");
  assert.equal(proposalImpact(withEvidence(2, 4)).label, "missed on 2 searches");
  assert.equal(proposalImpact(withEvidence(0, 0)).label, "no recorded miss");
});

test("a tool shown below first place is not counted as lost", () => {
  // Older evidence still carries `buried`. The agent saw the tool on those
  // searches, so they worked and must not read as a loss.
  const impact = proposalImpact(withEvidence(0, 1));
  assert.equal(impact.lost, 0);
  assert.equal(impact.label, "no recorded miss");
  assert.equal(proposalImpact(withEvidence(2, 4)).lost, 2);
});

test("stored in-list ranks are dropped from the failure rows", () => {
  const failures = proposalFailures({
    failures: [
      { query: "missed it", ourRank: null, ourTop: "x", baselineTop: "t", targetSource: "judge" },
      { query: "shown second", ourRank: 2, ourTop: "x", baselineTop: "t", targetSource: "judge" },
    ],
  });
  assert.deepEqual(
    failures.map((failure) => failure.query),
    ["missed it"],
  );
});

test("rows are ordered worst first, so position carries the magnitude", () => {
  const groups = groupProposals([
    withEvidence(0, 1, "small"),
    withEvidence(3, 1, "worst"),
    withEvidence(1, 0, "middle"),
  ]);
  assert.deepEqual(
    groups.pending.map((row) => row.entryName),
    ["worst", "middle", "small"],
  );
});

test("rows level on impact stay in a stable order rather than shuffling", () => {
  const first = groupProposals([withEvidence(1, 0, "beta"), withEvidence(1, 0, "alpha")]);
  const second = groupProposals([withEvidence(1, 0, "alpha"), withEvidence(1, 0, "beta")]);
  assert.deepEqual(
    first.pending.map((row) => row.entryName),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    second.pending.map((row) => row.entryName),
    ["alpha", "beta"],
  );
});

test("applied rows are ordered too, so the section reads the same way", () => {
  const groups = groupProposals([
    withEvidence(1, 0, "small", "applied"),
    withEvidence(5, 0, "worst", "applied"),
  ]);
  assert.deepEqual(
    groups.applied.map((row) => row.entryName),
    ["worst", "small"],
  );
});

test("malformed stored evidence scores zero rather than NaN", () => {
  const junk = {
    entryName: "t",
    evidence: { misses: "three", buried: null },
  } as unknown as MatchQualityProposalRow;
  const impact = proposalImpact(junk);
  assert.equal(impact.lost, 0);
  assert.equal(impact.label, "no recorded miss");
});

const LINES = [
  { arm: "ratel", tier: "revealed", n: 29, containment: 1, quality: 0.9, top1: 0.58 },
  { arm: "legacy", tier: "revealed", n: 29, containment: 0.83, quality: 0.8, top1: 0.79 },
  { arm: "ratel", tier: "judged", n: 284, containment: 0.852, quality: 0.81, top1: 0.658 },
  { arm: "legacy", tier: "judged", n: 284, containment: 0.901, quality: 0.889, top1: 0.835 },
];

test("both engines are measured on their own against the answer key", () => {
  const view = qualityNumbers(
    run({
      tunedArm: "ratel",
      baselineArm: "legacy",
      scores: { arms: LINES, answers: { searches: 508, answered: 337, unclear: 163, unread: 8 } },
    }),
  );
  assert.deepEqual(view?.ours, { arm: "ratel", top1: 0.658, containment: 0.852, n: 284 });
  assert.deepEqual(view?.theirs, { arm: "legacy", top1: 0.835, containment: 0.901, n: 284 });
  assert.deepEqual(view?.coverage, { searches: 508, answered: 337, unclear: 163, unread: 8 });
  assert.match(view?.caveat ?? "", /left out for both engines/);
});

test("with no answer-key line there are no numbers, never the self-graded revealed one", () => {
  // The revealed line reads ratel 100% contained: ratel served every search, so
  // the agent could only run what ratel showed it.
  const view = qualityNumbers(
    run({ tunedArm: "ratel", baselineArm: "legacy", scores: { arms: LINES.slice(0, 2) } }),
  );
  assert.equal(view?.ours, null);
  assert.equal(view?.theirs, null);
});

test("a run stored before top-1 existed still shows containment, not a guess", () => {
  const legacyLines = LINES.map(({ top1: _top1, ...line }) => line);
  const view = qualityNumbers(
    run({ tunedArm: "ratel", baselineArm: "legacy", scores: { arms: legacyLines } }),
  );
  assert.equal(view?.ours?.top1, null);
  assert.equal(view?.ours?.containment, 0.852);
  // Coverage falls back to the census when the run stored none.
  assert.equal(view?.coverage.unread, 20);
});

test("a window with nothing scored has no numbers to draw", () => {
  assert.equal(qualityNumbers(run({ selectionsEvaluated: 0, scores: {} })), null);
});

test("full capture is said once, and a shortfall as a fraction", () => {
  assert.equal(
    captureNote(run({ selectionsEvaluated: 37, queriesCaptured: 37 })),
    "all with query text",
  );
  assert.equal(
    captureNote(run({ selectionsEvaluated: 37, queriesCaptured: 12 })),
    "12 of 37 with query text",
  );
});

/* — the backtest readout ----------------------------------------------------- */

import { type ReplayCase, replay } from "./replay";
import type { CorpusEntry } from "./types";
import { backtestView } from "./view";

const BT_AT = new Date("2026-09-10T12:00:00Z");

function btEntry(entryId: string, searchable: string): CorpusEntry {
  return {
    entryId,
    name: entryId,
    searchable,
    source: "runtime",
    matchesAgentDescription: true,
    tags: [],
  };
}

const BT_CORPUS: CorpusEntry[] = [
  btEntry("refund_payment", "Handles ledger reversal operations."),
  btEntry("list_invoices", "Lists invoices for an account."),
];

function btCase(query: string, target: string, opts: Partial<ReplayCase> = {}): ReplayCase {
  return {
    queryKey: query.toLowerCase(),
    query,
    targetEntryId: target,
    source: "invoked",
    servedIds: null,
    baselineIds: null,
    occurredAt: BT_AT,
    ...opts,
  };
}

test("a missing or empty backtest has no readout rather than a zeroed one", () => {
  assert.equal(backtestView(null), null);
  assert.equal(backtestView(undefined), null);
  assert.equal(backtestView({ n: 0 }), null);
});

test("a gain prints both percentages, the change in points and the interval", () => {
  const cases = Array.from({ length: 30 }, (_unused, index) =>
    btCase(`give the customer their money back ${index}`, "refund_payment"),
  );
  const view = backtestView(
    replay(BT_CORPUS, cases, [
      {
        entryId: "refund_payment",
        searchableDescription: "Refunds a payment. Use when the customer wants their money back.",
      },
    ]),
  );

  assert.ok(view);
  assert.equal(view.direction, "up");
  assert.equal(view.before, "0%");
  assert.equal(view.after, "100%");
  assert.equal(view.delta, "+100 points");
  assert.equal(view.significant, true);
  assert.match(view.range, /points$/);
  assert.match(view.headline, /puts the right tool in the list 100 points more often/);
  // The number is printed; the caveat travels beside it rather than instead of it.
  assert.match(view.caveat, /keyword-only replay/);
  assert.match(view.caveat, /cancels/);
});

test("an unpatched replay reads as a standing measurement, not a change", () => {
  const view = backtestView(replay(BT_CORPUS, [btCase("list the invoices", "list_invoices")], []));

  assert.ok(view);
  assert.equal(view.standing, true);
  assert.equal(view.direction, "flat");
  assert.equal(view.delta, "no change");
  assert.match(view.headline, /somewhere in the list/);
  assert.equal(view.movements.length, 0);
});

test("the population line states how much of it stands on a known answer", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        btCase("refund it", "refund_payment", { source: "invoked" }),
        btCase("the invoices", "list_invoices", { source: "judge" }),
        btCase("something vague", "list_invoices", { source: "reference" }),
        btCase("another vague one", "list_invoices", { source: "reference" }),
      ],
      [],
    ),
  );

  assert.ok(view);
  assert.match(view.population, /4 distinct searches replayed/);
  assert.match(view.population, /50% of them against an answer we actually know/);
});

test("a target that has left the catalog is reported as skipped, not as a miss", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [btCase("refund it", "refund_payment"), btCase("do the thing", "deleted_tool")],
      [],
    ),
  );

  assert.ok(view);
  assert.match(view.population, /1 more were skipped because the tool they wanted has left/);
});

test("the incumbent's line is scored from its own recorded lists", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        btCase("refund it", "refund_payment", { baselineIds: ["refund_payment"] }),
        btCase("the invoices", "list_invoices", { baselineIds: ["refund_payment"] }),
      ],
      [],
    ),
  );

  assert.ok(view);
  assert.equal(view.baseline, "50%");
  assert.equal(view.baselineN, 2, "both answers here came from invocations");
  assert.match(view.baselineNote ?? "", /no replay, so no scorer error/i);
});

test("collateral damage surfaces as a regression list", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        btCase("lists invoices for an account", "list_invoices"),
        btCase("refund them", "refund_payment"),
      ],
      [
        {
          entryId: "refund_payment",
          searchableDescription:
            "Refund. Lists invoices for an account, invoices account invoices lists account.",
        },
      ],
    ),
  );

  assert.ok(view);
  assert.ok(view.regressions.length > 0, "the entry that lost ground should be listed");
  assert.equal(view.regressions[0].entryId, "list_invoices");
  assert.ok(view.regressions[0].delta < 0);
});

test("movement buckets are named in the reader's own words and empty ones are dropped", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [btCase("give the customer their money back", "refund_payment")],
      [
        {
          entryId: "refund_payment",
          searchableDescription: "Use when the customer wants their money back.",
        },
      ],
    ),
  );

  assert.ok(view);
  assert.deepEqual(
    view.movements.map((row) => row.label),
    ["newly found"],
  );
  assert.ok(view.movements.every((row) => row.n > 0));
});

test("the incumbent is not scored on searches where it defined the answer", () => {
  // The circularity found on production: with a reference-dominated population
  // the baseline scores ~100% by construction, because the target IS its own top
  // result. Only independently-answered searches may draw that line.
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        btCase("a", "refund_payment", { source: "reference", baselineIds: ["refund_payment"] }),
        btCase("b", "refund_payment", { source: "reference", baselineIds: ["refund_payment"] }),
        btCase("c", "refund_payment", { source: "reference", baselineIds: ["refund_payment"] }),
        // The only one whose answer came from somewhere other than the baseline,
        // and on it the baseline is wrong.
        btCase("d", "refund_payment", { source: "judge", baselineIds: ["list_invoices"] }),
      ],
      [],
    ),
  );

  assert.ok(view);
  assert.equal(view.baselineN, 1, "only the judged search may measure the baseline");
  assert.equal(view.baseline, "0%", "and on it the baseline missed");
  assert.match(view.baselineNote ?? "", /agrees with itself/);
});

test("with nothing but reference evidence the incumbent line is withheld entirely", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [btCase("a", "refund_payment", { source: "reference", baselineIds: ["refund_payment"] })],
      [],
    ),
  );

  assert.ok(view);
  assert.equal(view.baseline, null, "a tautology is not a comparison");
  assert.equal(view.baselineN, 0);
});

test("the head-to-head is measured over the same searches for both engines", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        // Independently answered: both engines may be scored here.
        btCase("a", "refund_payment", {
          source: "judge",
          servedIds: ["list_invoices", "refund_payment"],
          baselineIds: ["refund_payment"],
        }),
        btCase("b", "list_invoices", {
          source: "invoked",
          servedIds: ["list_invoices"],
          baselineIds: ["refund_payment"],
        }),
        // Incumbent-assumed: excluded from both sides, not just from theirs.
        btCase("c", "refund_payment", {
          source: "reference",
          servedIds: ["refund_payment"],
          baselineIds: ["refund_payment"],
        }),
      ],
      [],
    ),
  );

  assert.ok(view?.served);
  assert.equal(view.served.n, 2, "the assumed search is excluded from both engines");
  // Ours led correctly once of two; theirs led correctly once of two.
  assert.equal(view.served.ourTop1, "50%");
  assert.equal(view.served.baselineTop1, "50%");
  // But ours returned the answer on both, theirs on only one.
  assert.equal(view.served.ourContainment, "100%");
  assert.equal(view.served.baselineContainment, "50%");
  // And the list sizes that make containment easy or hard are stated.
  assert.equal(view.served.ourListSize, "1.5");
  assert.equal(view.served.baselineListSize, "1.0");
});

test("with nothing independently answered there is no head-to-head to show", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [btCase("a", "refund_payment", { source: "reference", baselineIds: ["refund_payment"] })],
      [],
    ),
  );
  assert.ok(view);
  assert.equal(view.served, null);
});

test("the head-to-head names where the gap lives, as a share of traffic", () => {
  const rows: ReplayCase[] = [];
  // Twelve searches where both engines lead with the same tool and both are
  // right: the majority of traffic, and a tie.
  for (let i = 0; i < 12; i += 1) {
    rows.push(
      btCase(`agreed ${i}`, "refund_payment", {
        source: i < 4 ? "judge" : "reference",
        servedIds: ["refund_payment"],
        baselineIds: ["refund_payment"],
      }),
    );
  }
  // Four where they disagree and only the incumbent is right.
  for (let i = 0; i < 4; i += 1) {
    rows.push(
      btCase(`disputed ${i}`, "refund_payment", {
        source: "judge",
        servedIds: ["list_invoices"],
        baselineIds: ["refund_payment"],
      }),
    );
  }

  const view = backtestView(replay(BT_CORPUS, rows, []));
  assert.ok(view?.served?.split);
  // 12 of 16 searches agreed, so the split must be stated over traffic.
  assert.match(view.served.split, /On 75% of searches both engines already lead/);
  assert.match(view.served.split, /other 25%/);
  // And it must name what we score inside that disputed minority.
  assert.match(view.served.split, /0% of the time against 100%/);
});

test("with only one kind of search there is no split worth drawing", () => {
  const view = backtestView(
    replay(
      BT_CORPUS,
      [
        btCase("a", "refund_payment", {
          source: "judge",
          servedIds: ["refund_payment"],
          baselineIds: ["refund_payment"],
        }),
      ],
      [],
    ),
  );
  assert.equal(view?.served?.split, null);
});

/* — reading blobs written by older code -------------------------------------- */

test("a backtest written before a field existed renders instead of throwing", () => {
  // Exactly what broke the page: a row stored an hour before `averageWindow`,
  // `served` and `strata` shipped. The TypeScript type describes new writes; the
  // database holds old ones, and the view has to survive both.
  const legacyBlob = {
    scorer: "bm25-replay",
    n: 389,
    before: { containment: 0.72, quality: 0.6 },
    after: { containment: 0.76, quality: 0.64 },
    delta: { quality: 0.04, interval: { low: 0.01, high: 0.07 }, significant: true },
    movements: { found: 3, promoted: 12 },
    byEntry: [],
    baseline: { containment: 0.83 },
    baselineN: 61,
    evidence: { invoked: 0, judged: 61, assumed: 328 },
  };

  const view = backtestView(legacyBlob);
  assert.ok(view, "an older row must still render");
  assert.equal(view.before, "72%");
  assert.equal(view.after, "76%");
  // No `averageWindow`, so the sentence drops the clause rather than inventing one.
  assert.doesNotMatch(view.headline, /judged inside/);
  assert.doesNotMatch(view.population, /each judged inside/);
  // No `served`, so the measured table is simply absent.
  assert.equal(view.served, null);
  // `delta.containment` was not written then; it reads as no change, not as NaN.
  assert.equal(view.delta, "no change");
  assert.ok(!view.before.includes("NaN"));
});

test("a blob with nothing but a count does not crash the panel", () => {
  const view = backtestView({ n: 5 });
  assert.ok(view);
  assert.equal(view.movements.length, 0);
  assert.equal(view.regressions.length, 0);
  assert.equal(view.baseline, null);
  assert.equal(view.served, null);
  assert.equal(view.significant, false);
});

test("a malformed byEntry is ignored rather than thrown on", () => {
  const view = backtestView({ n: 5, byEntry: "not an array" });
  assert.ok(view);
  assert.deepEqual(view.regressions, []);
});
