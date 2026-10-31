import assert from "node:assert/strict";
import { test } from "node:test";
import { type AnalystContext, buildAnalystPrompt, MAX_CORPUS_CHARS } from "./context";
import type { Candidate, CorpusEntry, RunCensus } from "./types";

function census(overrides: Partial<RunCensus> = {}): RunCensus {
  return {
    selectionsEvaluated: 120,
    revealedN: 80,
    referenceN: 40,
    judgedN: 0,
    queriesCaptured: 120,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: "ratel.experiment.invocation.tool_id",
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
    ...overrides,
  };
}

function entry(entryId: string, source = "runtime"): CorpusEntry {
  return {
    entryId,
    name: entryId,
    searchable: `Does ${entryId} things.`,
    source,
    matchesAgentDescription: true,
    tags: ["billing"],
  };
}

const CANDIDATE: Candidate = {
  entryId: "refund_payment",
  name: "refund_payment",
  misses: 3,
  buried: 1,
  targeted: 4,
  distractions: 2,
  loss: 3.4,
  failures: [
    {
      query: "give the money back",
      ourRank: null,
      ourTop: "list_invoices",
      baselineTop: "refund_payment",
      targetSource: "invoked",
    },
    {
      query: null,
      ourRank: 4,
      ourTop: "cancel_subscription",
      baselineTop: "refund_payment",
      targetSource: "reference",
    },
  ],
};

function context(overrides: Partial<AnalystContext> = {}): AnalystContext {
  return {
    projectName: "acme-mcp",
    census: census(),
    retrieval: { stages: ["bm25", "dense", "rrf"], topK: 5, samples: 90 },
    quality: [
      { arm: "ratel", tier: "revealed", n: 80, containment: 0.807, quality: 0.618 },
      { arm: "legacy", tier: "revealed", n: 80, containment: 0.85, quality: 0.795 },
    ],
    gapNote: "The gap is mostly ranking rather than coverage.",
    referenceAccuracy: null,
    corpus: [entry("refund_payment"), entry("list_invoices")],
    candidates: [CANDIDATE],
    ...overrides,
  };
}

test("the system prompt names both descriptions and says which one is edited", () => {
  const { system } = buildAnalystPrompt(context());
  assert.match(system, /Searchable description/);
  assert.match(system, /Agent description/);
  assert.match(system, /editing the FIRST one and nothing else/);
  assert.match(system, /never sees the first/);
});

test("the system prompt warns about BM25 saturation and the indexed name", () => {
  const { system } = buildAnalystPrompt(context());
  assert.match(system, /REPEATING ONE TERM SATURATES/);
  assert.match(system, /NAME IS ALREADY INDEXED/);
});

test("the system prompt refuses to treat baseline agreement as correctness", () => {
  const { system } = buildAnalystPrompt(context());
  assert.match(system, /left out\s+rather than scored against the incumbent's guess/);
  assert.match(system, /matching it exactly means you have reached parity/);
  assert.match(system, /NO INVENTED PROBLEMS/);
});

test("the user message carries the census, the quality read and the failures", () => {
  const { user } = buildAnalystPrompt(context());
  assert.match(user, /Searches scored: 120/);
  assert.match(user, /behaviour: 80/);
  assert.match(user, /no answer yet \(left out of everything\): 40/);
  assert.match(user, /Baseline arm: legacy; serving arm: ratel/);
  assert.match(user, /rank-weighted quality 61\.8%/);
  assert.match(user, /"give the money back" \[invoked \| we-missed-it\] -> we did not return it/);
  assert.match(
    user,
    /\(query text not captured\) \[reference \| we-buried-it\] -> we ranked it #4/,
  );
  assert.match(user, /The gap is mostly ranking rather than coverage\./);
});

test("an absent retrieval observation is stated, never guessed", () => {
  const { user } = buildAnalystPrompt(
    context({ retrieval: { stages: [], topK: null, samples: 0 } }),
  );
  assert.match(user, /Not observed in this window/);
  assert.match(user, /does not store a per-project retrieval configuration/);
  assert.match(user, /assume nothing/);
});

test("a window with no invoked evidence says so in the census", () => {
  const { user } = buildAnalystPrompt(
    context({ census: census({ revealedN: 0, referenceN: 120, attributionMode: "none" }) }),
  );
  assert.match(user, /no search in this window recorded which entry the agent actually ran/);
});

test("uncaptured queries are called out as a gap rather than left implied", () => {
  const { user } = buildAnalystPrompt(
    context({ census: census({ selectionsEvaluated: 120, queriesCaptured: 30 }) }),
  );
  assert.match(user, /90 search\(es\) have no query text/);
});

test("an already-overridden entry is labelled in the corpus", () => {
  const { user } = buildAnalystPrompt({
    ...context(),
    corpus: [entry("refund_payment", "override")],
  });
  assert.match(user, /refund_payment \(already overridden in Ratel\)/);
});

test("an oversized corpus keeps the candidates and reports what it dropped", () => {
  const filler: CorpusEntry[] = [];
  for (let i = 0; i < 400; i++) {
    filler.push({
      entryId: `filler_${i}`,
      name: `filler_${i}`,
      searchable: "x".repeat(400),
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    });
  }
  const { user } = buildAnalystPrompt(context({ corpus: [...filler, entry("refund_payment")] }));
  assert.match(user, /- refund_payment\n/);
  assert.match(user, /further entries omitted for length/);
  assert.ok(user.length < MAX_CORPUS_CHARS + 20_000);
});

test("the prompt is deterministic", () => {
  const first = buildAnalystPrompt(context());
  const second = buildAnalystPrompt(context());
  assert.deepEqual(first, second);
});
