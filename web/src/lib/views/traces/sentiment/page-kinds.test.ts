import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAILURE_FOLLOWED,
  MODEL_CAUSES,
  NEGATIVE_REACTIONS,
  OUTCOME_CAUSES,
  REACTIONS,
  SATISFACTIONS,
  SESSION_OUTCOMES,
  type StoredFailureStreak,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  CAUSE_LABEL,
  CAUSE_MEANING,
  CAUSE_OWNER,
  CAUSE_OWNERS,
  PAGE_CAUSES,
  ROOT_CAUSES,
  rootCauseOf,
  SESSION_OUTCOME_LABEL,
  STORED_REACTIONS,
  sessionOutcomeOf,
} from "@/lib/views/traces/sentiment/page-kinds";
import {
  buildSentimentPage,
  occurrencesOf,
  type PageTurn,
  type SentimentPageInput,
} from "@/lib/views/traces/sentiment/page-model";
import { DEFAULT_SENTIMENT_QUERY } from "@/lib/views/traces/sentiment/page-paths";

/**
 * The page against the shared list (`kinds.ts`): every value the rule layer,
 * the model layer and the fusion can write is fed to the page model, and the
 * test fails on any the page does not know, drops, or sends to `other`.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const AT = new Date("2026-09-01T10:00:00Z");

test("every stored cause reads as itself, with a label, a meaning and who fixes it", () => {
  for (const cause of [...OUTCOME_CAUSES, ...MODEL_CAUSES]) {
    assert.equal(rootCauseOf(cause), cause, `${cause} is a cause the page knows`);
    assert.ok(CAUSE_LABEL[cause]?.trim(), `${cause} has a label`);
    assert.ok(CAUSE_MEANING[cause]?.trim(), `${cause} has a meaning`);
    assert.ok(CAUSE_OWNERS.includes(CAUSE_OWNER[cause]), `${cause} names who fixes it`);
  }
  // Only the rule layer's own `other` reads as other.
  assert.deepEqual(
    [...OUTCOME_CAUSES, ...MODEL_CAUSES].filter((cause) => rootCauseOf(cause) === "other"),
    ["other"],
  );
  assert.equal(
    new Set(ROOT_CAUSES).size,
    OUTCOME_CAUSES.length + MODEL_CAUSES.length + PAGE_CAUSES.length,
  );
  assert.equal(
    new Set(ROOT_CAUSES.map((cause) => CAUSE_LABEL[cause])).size,
    ROOT_CAUSES.length,
    "no two causes share a label",
  );
  assert.deepEqual(
    MODEL_CAUSES.map((cause) => [cause, CAUSE_OWNER[cause]]),
    [
      ["misread_request", "prompt"],
      ["ignored_instruction", "prompt"],
      ["missing_capability", "roadmap"],
      ["incomplete", "prompt"],
      ["false_success", "prompt"],
      ["over_asking", "prompt"],
      ["unhelpful_answer", "prompt"],
      ["correct_refusal", "nobody"],
      ["unclear_request", "nobody"],
    ],
  );
  assert.equal(
    rootCauseOf("a cause a later version adds"),
    "other",
    "a value outside the shared list still reads, as other",
  );
  assert.equal(rootCauseOf(null), null);
});

test("every stored outcome has a label and reads as stored; every reaction is counted under its stored name", () => {
  for (const outcome of SESSION_OUTCOMES) assert.ok(SESSION_OUTCOME_LABEL[outcome].trim(), outcome);
  // The model layer stores a reaction it asked for and did not get as `unknown`.
  assert.deepEqual(STORED_REACTIONS, [...REACTIONS, "unknown"]);
  assert.equal(SESSION_OUTCOME_LABEL.resolved_clean, "Resolved cleanly");
  for (const outcome of SESSION_OUTCOMES) {
    for (const source of ["rule", "model"] as const) {
      assert.deepEqual(
        sessionOutcomeOf({ outcome, outcomeSource: source, frictionCount: 0, openRequest: false }),
        { outcome, source },
        `${outcome} is read as stored`,
      );
    }
  }
});

function streak(
  cause: StoredFailureStreak["cause"],
  followed: StoredFailureStreak["followed"],
): StoredFailureStreak {
  return {
    tool: "update_task",
    ordinal: 1,
    errors: 1,
    cause,
    followed,
    recovered: followed !== "nothing_followed",
  };
}

test("the page model drops nothing the reading can write: every satisfaction, reaction, cause and follow-up is counted", () => {
  const turns: PageTurn[] = [];
  const add = (over: Partial<PageTurn>) =>
    turns.push({
      turnId: `t-${turns.length}`,
      sessionId: `s-${turns.length}`,
      startedAt: AT,
      endedAt: AT,
      costUsd: null,
      cause: null,
      causeSource: null,
      failures: [],
      unmetSearches: 0,
      satisfaction: null,
      reaction: null,
      ...over,
    });
  // The rule layer: every cause of a failed call, under every follow-up.
  for (const cause of OUTCOME_CAUSES)
    for (const followed of FAILURE_FOLLOWED)
      add({ cause, causeSource: "rule", failures: [streak(cause, followed)] });
  // The model layer and the fusion: every cause a model can choose, with every satisfaction and reaction.
  for (const [i, cause] of MODEL_CAUSES.entries())
    add({
      cause,
      causeSource: "model",
      satisfaction: SATISFACTIONS[i % SATISFACTIONS.length]!,
      reaction: STORED_REACTIONS[i % STORED_REACTIONS.length]!,
    });

  const satisfaction = Object.fromEntries(SATISFACTIONS.map((value, i) => [value, i + 1]));
  const reactions = Object.fromEntries(STORED_REACTIONS.map((value, i) => [value, i + 1]));
  const input: SentimentPageInput = {
    projectId: "p1",
    windowDays: 30,
    now: NOW,
    turns,
    sessions: [],
    intents: new Map(),
    totals: {
      turns: turns.length,
      answered: turns.length,
      textTurns: turns.length,
      messages: turns.length,
      satisfaction,
      reactions,
    },
    modelConfigured: true,
    costKnown: false,
    answers: [],
    tasks: [],
    capped: false,
    minSessions: 1,
  };
  const page = buildSentimentPage(input, DEFAULT_SENTIMENT_QUERY);

  // Answers: every stored satisfaction and reaction keeps its count.
  assert.deepEqual(page.text.satisfaction, satisfaction);
  assert.deepEqual(page.text.reactions, reactions);

  // Causes: each stored cause is its own root cause, none folded into another, and only the rules' own `other` reads as other.
  const found = turns.flatMap(occurrencesOf);
  assert.deepEqual(
    [...new Set(found.map((occurrence) => occurrence.cause))].sort(),
    [...OUTCOME_CAUSES, ...MODEL_CAUSES].sort(),
  );
  assert.equal(
    found.filter((occurrence) => occurrence.cause === "other").length,
    FAILURE_FOLLOWED.length,
  );
  for (const cause of MODEL_CAUSES) {
    const occurrence = found.find((o) => o.cause === cause);
    assert.deepEqual(
      [occurrence?.source, occurrence?.unresolved],
      [
        "model",
        // A correct refusal is never unresolved.
        cause !== "correct_refusal",
      ],
      cause,
    );
  }
  assert.ok(NEGATIVE_REACTIONS.every((reaction) => REACTIONS.includes(reaction)));
});
