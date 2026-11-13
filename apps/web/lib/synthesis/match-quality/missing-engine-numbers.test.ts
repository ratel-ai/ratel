import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchQualityRunRow } from "@/lib/synthesis/match-quality/schema";
import {
  type EngineQuality,
  MISSING_ENGINE_NUMBERS_COPY,
  missingEngineNumbers,
  qualityNumbers,
} from "./view";

const OURS: EngineQuality = { arm: "ratel", top1: 0.6, containment: 0.8, n: 40 };

function coverage(answered: number) {
  return { searches: 598, answered, unclear: 0, unread: 598 - answered };
}

function run(scores: Record<string, unknown>): Pick<MatchQualityRunRow, "scores"> {
  return { scores };
}

test("a new run whose answers were all run from the served list says no judged answers, not an old run", () => {
  // Exactly the local case: a brand new run, every answer an invocation, no judge.
  const fresh = run({ arms: [], answers: { searches: 598, answered: 598, unclear: 0, unread: 0 } });
  const stored = { ours: null, theirs: null, coverage: coverage(598) };
  assert.equal(missingEngineNumbers(stored, "stored", fresh), "no-judged");
  assert.equal(
    missingEngineNumbers(stored, "live", fresh),
    "no-judged",
    "numbers computed now are never old",
  );
  assert.doesNotMatch(
    MISSING_ENGINE_NUMBERS_COPY["no-judged"],
    /stored before|Jev|judge model|BM25/,
  );
});

test("only a stored run without its answer census predates per-engine numbers", () => {
  const old = run({ arms: [{ arm: "ratel", tier: "reference", containment: 0.7, n: 30 }] });
  assert.equal(
    missingEngineNumbers({ ours: null, theirs: null, coverage: coverage(12) }, "stored", old),
    "stored-before",
  );
  assert.match(
    MISSING_ENGINE_NUMBERS_COPY["stored-before"],
    /stored before per-engine numbers existed/,
  );
});

test("no answer at all, or a number to show", () => {
  assert.equal(
    missingEngineNumbers({ ours: null, theirs: null, coverage: coverage(0) }, "stored", run({})),
    "no-answers",
  );
  assert.equal(
    missingEngineNumbers({ ours: OURS, theirs: null, coverage: coverage(40) }, "stored", run({})),
    null,
  );
});

test("the stored reading of a fresh run with no judged line agrees with the classifier", () => {
  const fresh = {
    selectionsEvaluated: 598,
    revealedN: 598,
    judgedN: 0,
    referenceN: 0,
    tunedArm: "ratel",
    baselineArm: null,
    scores: { arms: [], answers: { searches: 598, answered: 598, unclear: 0, unread: 0 } },
  } as unknown as MatchQualityRunRow;
  const numbers = qualityNumbers(fresh);
  assert.ok(numbers);
  assert.equal(missingEngineNumbers(numbers, "stored", fresh), "no-judged");
});
