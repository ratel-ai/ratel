import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import { type AnalystDeps, analyse, parseAnalystResponse } from "./analyst";
import type { AnalystContext } from "./context";
import type { CorpusEntry } from "./types";

const CORPUS_IDS = new Set(["refund_payment", "list_invoices"]);

function proposal(entryId: string, searchableDescription: string) {
  return { entryId, searchableDescription, rationale: "because", expectedEffect: "better" };
}

test("a well-formed answer parses into a diagnosis and proposals", () => {
  const raw = JSON.stringify({
    diagnosis: "Near-synonym entries never say what makes them different.",
    diagnosisPoints: [],
    proposals: [proposal("refund_payment", "Reverses a charge. Use when a refund is asked for.")],
  });
  const result = parseAnalystResponse(raw, CORPUS_IDS);
  assert.equal(
    result.diagnosis.headline,
    "Near-synonym entries never say what makes them different.",
  );
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].entryId, "refund_payment");
  assert.deepEqual(result.rejectedEntryIds, []);
});

test("an empty proposal list is a valid answer, not a failure", () => {
  const result = parseAnalystResponse(
    JSON.stringify({ diagnosis: "Nothing here needs changing.", proposals: [] }),
    CORPUS_IDS,
  );
  assert.deepEqual(result.proposals, []);
  assert.equal(result.diagnosis.headline, "Nothing here needs changing.");
});

test("an entry id that is not in the corpus is dropped and reported", () => {
  const result = parseAnalystResponse(
    JSON.stringify({
      diagnosis: "d",
      diagnosisPoints: [],
      proposals: [proposal("invented_tool", "text"), proposal("refund_payment", "real text")],
    }),
    CORPUS_IDS,
  );
  assert.deepEqual(
    result.proposals.map((p) => p.entryId),
    ["refund_payment"],
  );
  assert.deepEqual(result.rejectedEntryIds, ["invented_tool"]);
});

test("a proposal identical to the current text is a no-op and is dropped", () => {
  const current = new Map([["refund_payment", "Reverses a charge."]]);
  const result = parseAnalystResponse(
    JSON.stringify({
      diagnosis: "d",
      proposals: [proposal("refund_payment", "Reverses a charge.")],
    }),
    CORPUS_IDS,
    current,
  );
  assert.deepEqual(result.proposals, []);
});

test("text longer than the column allows is dropped rather than truncated", () => {
  const result = parseAnalystResponse(
    JSON.stringify({
      diagnosis: "d",
      diagnosisPoints: [],
      proposals: [proposal("refund_payment", "x".repeat(MAX_DESCRIPTION + 1))],
    }),
    CORPUS_IDS,
  );
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.rejectedEntryIds, ["refund_payment"]);
});

test("two proposals for one entry keep the first", () => {
  const result = parseAnalystResponse(
    JSON.stringify({
      diagnosis: "d",
      diagnosisPoints: [],
      proposals: [proposal("refund_payment", "first"), proposal("refund_payment", "second")],
    }),
    CORPUS_IDS,
  );
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].searchableDescription, "first");
});

test("rows missing required fields are skipped without losing the rest", () => {
  const result = parseAnalystResponse(
    JSON.stringify({
      diagnosis: "d",
      diagnosisPoints: [],
      proposals: [
        { entryId: "refund_payment" },
        { searchableDescription: "orphan" },
        null,
        "nonsense",
        proposal("list_invoices", "Lists invoices. Use when asked to see billing history."),
      ],
    }),
    CORPUS_IDS,
  );
  assert.deepEqual(
    result.proposals.map((p) => p.entryId),
    ["list_invoices"],
  );
});

test("output with no JSON object at all throws rather than being guessed at", () => {
  assert.throws(() => parseAnalystResponse("I would rather not.", CORPUS_IDS));
});

test("analyse feeds the corpus to the parser so the model cannot invent an id", async () => {
  const corpus: CorpusEntry[] = [
    {
      entryId: "refund_payment",
      name: "refund_payment",
      searchable: "Reverses a charge.",
      source: "runtime",
      matchesAgentDescription: true,
      tags: [],
    },
  ];
  const context: AnalystContext = {
    projectName: "p",
    census: {
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
    },
    retrieval: { stages: [], topK: null, samples: 0 },
    quality: [],
    gapNote: null,
    referenceAccuracy: null,
    corpus,
    candidates: [],
  };
  let sawSystem = "";
  const deps: AnalystDeps = {
    model: "test-model",
    complete: async (system) => {
      sawSystem = system;
      return JSON.stringify({
        diagnosis: "d",
        diagnosisPoints: [],
        proposals: [proposal("not_real", "x"), proposal("refund_payment", "New text entirely.")],
      });
    },
  };
  const result = await analyse(context, deps);
  assert.match(sawSystem, /Searchable description/);
  assert.deepEqual(
    result.proposals.map((p) => p.entryId),
    ["refund_payment"],
  );
  assert.deepEqual(result.rejectedEntryIds, ["not_real"]);
});
