import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAILURE_FOLLOWED,
  MODEL_CAUSES,
  NEGATIVE_REACTIONS,
  OUTCOME_CAUSES,
  REACTIONS,
  RULE_SESSION_OUTCOMES,
  SATISFACTIONS,
  SESSION_OUTCOMES,
  type StoredFailureStreak,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  CAUSE_LABEL,
  CAUSE_MEANING,
  CAUSE_OWNER,
  CAUSE_OWNERS,
  OWNER_LABEL,
  PAGE_CAUSES,
  REACTION_LABEL,
  ROOT_CAUSES,
  rootCauseOf,
  SATISFACTION_LABEL,
  SESSION_OUTCOME_LABEL,
  STORED_REACTIONS,
  sessionOutcomeOf,
  TEXT_ONLY_OUTCOMES,
} from "@/lib/views/traces/sentiment/page-kinds";
import {
  buildSentimentPage,
  type PageSession,
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
  for (const owner of CAUSE_OWNERS) assert.ok(OWNER_LABEL[owner].trim());
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

test("every stored outcome, satisfaction and reaction has a label, under its stored name", () => {
  for (const outcome of SESSION_OUTCOMES) assert.ok(SESSION_OUTCOME_LABEL[outcome].trim(), outcome);
  for (const satisfaction of SATISFACTIONS)
    assert.ok(SATISFACTION_LABEL[satisfaction].trim(), satisfaction);
  for (const reaction of STORED_REACTIONS) assert.ok(REACTION_LABEL[reaction].trim(), reaction);
  // The model layer stores a reaction it asked for and did not get as `unknown`.
  assert.deepEqual(STORED_REACTIONS, [...REACTIONS, "unknown"]);
  assert.equal(REACTION_LABEL.unknown, "Not decided");
  assert.equal(SESSION_OUTCOME_LABEL.resolved_clean, "Resolved cleanly");
  assert.equal(REACTION_LABEL.asks_human, "Asks for a human");
  assert.equal(SATISFACTION_LABEL.unknown, "Not decided");
  for (const outcome of SESSION_OUTCOMES) {
    for (const source of ["rule", "model"] as const) {
      assert.deepEqual(
        sessionOutcomeOf({ outcome, outcomeSource: source, frictionCount: 0, openRequest: false }),
        { outcome, source },
        `${outcome} is read as stored`,
      );
    }
  }
  // The note under the split names only what the rules never write.
  assert.deepEqual(TEXT_ONLY_OUTCOMES, ["escalated"]);
  assert.ok(RULE_SESSION_OUTCOMES.includes("gave_up"), "the rules write gave up");
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

test("the page model drops nothing the reading can write: every outcome, satisfaction, reaction, cause and follow-up is counted", () => {
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
  MODEL_CAUSES.forEach((cause, i) =>
    add({
      cause,
      causeSource: "model",
      satisfaction: SATISFACTIONS[i % SATISFACTIONS.length]!,
      reaction: STORED_REACTIONS[i % STORED_REACTIONS.length]!,
    }),
  );

  const sessions: PageSession[] = SESSION_OUTCOMES.flatMap((outcome) =>
    (["rule", "model"] as const).map((source) => ({
      sessionId: `o-${outcome}-${source}`,
      outcome,
      outcomeSource: source,
      frictionCount: 0,
      openRequest: false,
      endedAt: AT,
    })),
  );
  const satisfaction = Object.fromEntries(SATISFACTIONS.map((value, i) => [value, i + 1]));
  const reactions = Object.fromEntries(STORED_REACTIONS.map((value, i) => [value, i + 1]));
  const input: SentimentPageInput = {
    projectId: "p1",
    windowDays: 30,
    now: NOW,
    turns,
    sessions,
    intents: new Map(),
    versions: new Map(),
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
  const page = buildSentimentPage(input, { ...DEFAULT_SENTIMENT_QUERY, thin: true });

  // Sessions: each stored outcome is its own class, counted in full.
  assert.deepEqual(
    page.split.classes.map((entry) => [entry.outcome, entry.sessions]),
    SESSION_OUTCOMES.map((outcome) => [outcome, 2]),
  );
  assert.equal(page.split.total, sessions.length);

  // Answers: every stored satisfaction and reaction keeps its count.
  assert.deepEqual(page.text.satisfaction, satisfaction);
  assert.deepEqual(page.text.reactions, reactions);

  // Causes: one row per stored cause, none folded into another, and only the rules' own `other` reads as other.
  const causes = page.rows.map((row) => row.cause).sort();
  assert.deepEqual(causes, [...OUTCOME_CAUSES, ...MODEL_CAUSES].sort());
  assert.equal(page.rows.find((row) => row.cause === "other")?.sessions, FAILURE_FOLLOWED.length);
  for (const cause of MODEL_CAUSES) {
    const row = page.rows.find((r) => r.cause === cause);
    assert.deepEqual(
      [row?.sessions, row?.readBy, row?.owner],
      [1, "model", CAUSE_OWNER[cause]],
      cause,
    );
  }
  assert.equal(
    page.rows.find((row) => row.cause === "correct_refusal")?.unresolved,
    0,
    "a correct refusal is never unresolved",
  );
  assert.ok(
    MODEL_CAUSES.filter((cause) => cause !== "correct_refusal").every(
      (cause) => page.rows.find((row) => row.cause === cause)?.unresolved === 1,
    ),
  );

  // Reactions on rows: every reaction a row's turns carry is counted under its stored name.
  const onRows = page.rows.flatMap((row) => Object.keys(row.reactions));
  assert.deepEqual(
    [...new Set(onRows)].sort(),
    [...STORED_REACTIONS].sort(),
    "every stored reaction, the undecided one included, is counted on a row",
  );
  assert.ok(NEGATIVE_REACTIONS.every((reaction) => REACTIONS.includes(reaction)));
});
