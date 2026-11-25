import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FusionSessionTurn,
  type FusionTurnFacts,
  isFalseCompletion,
  objectedTo,
  sessionOutcome,
  traceFailed,
  turnResult,
} from "@/lib/readings/trace-signals/outcomes/fusion";
import {
  RULE_SESSION_OUTCOMES,
  SESSION_OUTCOMES,
  TURN_RESULTS,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import { NO_ANSWERS, type TurnAnswers } from "@/lib/readings/trace-signals/outcomes/questions";

/** Every class of turn result and of session outcome, from invented facts and answers. No call is made. */

const WORKED: FusionTurnFacts = { okCalls: 2, failedCalls: 0, unmetSearches: 0, failures: [] };
/** A call failed and nothing ran after it. */
const ERRORED: FusionTurnFacts = {
  okCalls: 1,
  failedCalls: 1,
  unmetSearches: 0,
  failures: [{ followed: "nothing_followed", recovered: false }],
};
/** A call failed and the same tool worked on the next try. */
const FIXED: FusionTurnFacts = {
  okCalls: 2,
  failedCalls: 1,
  unmetSearches: 0,
  failures: [{ followed: "fixed_next_try", recovered: true }],
};
/** A search run and no call. */
const SEARCHED: FusionTurnFacts = { okCalls: 0, failedCalls: 0, unmetSearches: 1, failures: [] };
/** No call at all: the agent only replied. */
const TALKED: FusionTurnFacts = { okCalls: 0, failedCalls: 0, unmetSearches: 0, failures: [] };

const answers = (over: Partial<TurnAnswers>): TurnAnswers => ({ ...NO_ANSWERS, ...over });
const result = (facts: FusionTurnFacts, over: Partial<TurnAnswers> = {}) => {
  const fused = turnResult(facts, answers(over));
  return [fused.result, fused.source];
};

// ---- Turn result -----------------------------------------------------------

test("the turn results are completed, completed wrong, failed and refused", () => {
  assert.deepEqual([...TURN_RESULTS], ["completed", "completed_wrong", "failed", "refused"]);
});

test("completed: the calls worked and the answers agree", () => {
  assert.deepEqual(
    result(WORKED, {
      completed: "yes",
      satisfied: "yes",
      reaction: "satisfied",
      misunderstood: "no",
    }),
    ["completed", "model"],
  );
  // The person moved on to something else: neutral, and still completed.
  assert.deepEqual(
    result(WORKED, { completed: "yes", satisfied: "yes", reaction: "new_request" }),
    ["completed", "model"],
  );
  // The last turn of a session: only its own work was asked about.
  assert.deepEqual(result(WORKED, { completed: "yes" }), ["completed", "model"]);
  // No call, and the model says the reply did what was asked.
  assert.deepEqual(result(TALKED, { completed: "yes" }), ["completed", "model"]);
});

test("completed: an error the agent fixed in the turn does not fail it", () => {
  assert.deepEqual(result(FIXED, { completed: "yes", satisfied: "yes" }), ["completed", "model"]);
  assert.equal(traceFailed(FIXED), false);
});

test("completed: an error in a turn that still gave the person what they wanted", () => {
  assert.deepEqual(result(ERRORED, { completed: "yes", satisfied: "yes", reaction: "satisfied" }), [
    "completed",
    "model",
  ]);
});

test("completed wrong: every call succeeded and the person's next message objects", () => {
  // "close the onboarding task" -> "Marked ONB-3 as Done." -> "I did not say that one"
  assert.deepEqual(
    result(WORKED, {
      completed: "yes",
      satisfied: "no",
      reaction: "corrects",
      misunderstood: "yes",
    }),
    ["completed_wrong", "model"],
  );
  assert.deepEqual(result(WORKED, { completed: "yes", satisfied: "no", reaction: "repeats" }), [
    "completed_wrong",
    "model",
  ]);
  // A "no" with no pushing back read is not an objection: the trace stands.
  assert.notEqual(
    result(WORKED, { completed: "unknown", satisfied: "no", reaction: "unknown" })[0],
    "completed_wrong",
  );
});

test("completed wrong: the agent misunderstood, even with no objection read", () => {
  assert.deepEqual(
    result(WORKED, { completed: "yes", misunderstood: "yes", satisfied: "unknown" }),
    ["completed_wrong", "model"],
  );
});

test("failed: the trace ended in an error", () => {
  assert.deepEqual(result(ERRORED, { completed: "no", satisfied: "no", reaction: "corrects" }), [
    "failed",
    "model",
  ]);
  // The model believes the reply, the trace does not, and nobody said they were satisfied.
  assert.deepEqual(result(ERRORED, { completed: "yes" }), ["failed", "model"]);
  // A search run and no call, and the person objects.
  assert.deepEqual(result(SEARCHED, { completed: "no", satisfied: "no" }), ["failed", "model"]);
  assert.equal(traceFailed(ERRORED), true);
  assert.equal(traceFailed(SEARCHED), true);
  assert.equal(
    traceFailed({
      okCalls: 1,
      failedCalls: 1,
      unmetSearches: 0,
      failures: [{ followed: "switched_tool", recovered: false }],
    }),
    true,
  );
  assert.equal(
    traceFailed({
      okCalls: 1,
      failedCalls: 1,
      unmetSearches: 0,
      failures: [{ followed: "switched_tool", recovered: true }],
    }),
    false,
  );
});

test("failed: no error in the trace, and the model says the agent did not complete it", () => {
  // "cancel my subscription" -> a discount offer, the cancel never ran.
  assert.deepEqual(result(WORKED, { completed: "no", satisfied: "no", reaction: "repeats" }), [
    "failed",
    "model",
  ]);
  assert.deepEqual(result(TALKED, { completed: "no" }), ["failed", "model"]);
});

test("false completion: the reply says done while the trace ended in an error, and the turn failed", () => {
  // "Done. RS-202 is closed and Ada has been notified." while add_task_comment failed.
  const fused = turnResult(ERRORED, answers({ claims: "yes", completed: "yes" }));
  assert.deepEqual(
    [fused.result, fused.source, fused.falseCompletion, fused.cause],
    ["failed", "model", true, "false_success"],
  );
  // Even when the person thanks the agent for it: they believed the reply.
  const thanked = turnResult(
    ERRORED,
    answers({ claims: "yes", completed: "yes", satisfied: "yes", reaction: "satisfied" }),
  );
  assert.deepEqual([thanked.result, thanked.falseCompletion], ["failed", true]);
  // A reply that admits the error is not one, and neither is "done" over a trace that worked.
  assert.equal(
    turnResult(ERRORED, answers({ claims: "no", completed: "no" })).falseCompletion,
    false,
  );
  assert.equal(
    turnResult(WORKED, answers({ claims: "yes", completed: "yes" })).falseCompletion,
    false,
  );
  assert.equal(
    turnResult(FIXED, answers({ claims: "yes", completed: "yes" })).falseCompletion,
    false,
  );
  // Read back from a stored row.
  assert.equal(isFalseCompletion({ claimedDone: true, result: "failed" }), true);
  assert.equal(isFalseCompletion({ claimedDone: true, result: "completed" }), false);
  assert.equal(isFalseCompletion({ claimedDone: null, result: "failed" }), false);
});

test("refused: a correct refusal does not count against the agent", () => {
  // A refund refused correctly after 40 days, "worst support ever".
  const fused = turnResult(
    TALKED,
    answers({ completed: "no", satisfied: "no", reaction: "gives_up", cause: "correct_refusal" }),
  );
  assert.deepEqual(
    [fused.result, fused.source, fused.falseCompletion],
    ["refused", "model", false],
  );
  // Not failed and not completed wrong, whatever the person says next, and whatever the trace did.
  assert.deepEqual(
    result(WORKED, {
      completed: "no",
      satisfied: "no",
      reaction: "corrects",
      misunderstood: "yes",
      cause: "correct_refusal",
    }),
    ["refused", "model"],
  );
  assert.deepEqual(result(ERRORED, { completed: "no", cause: "correct_refusal" }), [
    "refused",
    "model",
  ]);
  // Any other cause leaves the turn a failure.
  assert.deepEqual(
    result(TALKED, { completed: "no", satisfied: "no", cause: "unhelpful_answer" }),
    ["failed", "model"],
  );
});

test("a changed mind is not a correction", () => {
  // "actually, on second thought let's use Redis": a new request, whatever the satisfaction question made of it.
  for (const satisfied of ["yes", "no", "unknown"] as const) {
    assert.equal(objectedTo(answers({ satisfied, reaction: "new_request" })), false);
    assert.deepEqual(
      result(WORKED, { completed: "yes", satisfied, reaction: "new_request", misunderstood: "no" }),
      ["completed", "model"],
    );
  }
  // A real correction is one.
  assert.equal(objectedTo(answers({ satisfied: "no", reaction: "corrects" })), true);
  assert.deepEqual(
    result(WORKED, {
      completed: "yes",
      satisfied: "no",
      reaction: "corrects",
      misunderstood: "no",
    }),
    ["completed_wrong", "model"],
  );
});

test("with the rules alone a turn is failed or completed, and says the trace decided it", () => {
  assert.deepEqual(result(WORKED), ["completed", "rule"]);
  assert.deepEqual(result(FIXED), ["completed", "rule"]);
  assert.deepEqual(result(ERRORED), ["failed", "rule"]);
  assert.deepEqual(result(SEARCHED), ["failed", "rule"]);
  // Nothing ran and nothing was answered: nothing is known.
  assert.deepEqual(result(TALKED), [null, null]);
  // The request gate and the search-run answer do not bear on the result.
  assert.deepEqual(result(SEARCHED, { searchRun: "one_need", asks: "yes" }), ["failed", "rule"]);
  assert.equal(turnResult(ERRORED, NO_ANSWERS).falseCompletion, false);
});

// ---- Session outcome -------------------------------------------------------

const turn = (over: Partial<FusionSessionTurn> = {}): FusionSessionTurn => ({
  okCalls: 1,
  failedCalls: 0,
  streaks: 0,
  unmetSearches: 0,
  ...over,
});
const good = (over: Partial<FusionSessionTurn> = {}) =>
  turn({
    result: "completed",
    resultSource: "model",
    satisfaction: "satisfied",
    reaction: "satisfied",
    ...over,
  });
const outcome = (...turns: FusionSessionTurn[]) => {
  const fused = sessionOutcome(turns);
  return [fused?.outcome, fused?.source];
};

test("the session outcomes are resolved cleanly, resolved after friction, gave up, blocked and escalated", () => {
  assert.deepEqual(
    [...SESSION_OUTCOMES],
    ["resolved_clean", "resolved_after_friction", "gave_up", "blocked", "escalated"],
  );
  assert.equal(sessionOutcome([]), null);
});

test("resolved cleanly: every turn completed and nothing was objected to", () => {
  assert.deepEqual(outcome(good({ satisfaction: "neutral", reaction: "new_request" }), good()), [
    "resolved_clean",
    "model",
  ]);
  // The last turn has no message after it.
  assert.deepEqual(outcome(good(), turn({ result: "completed", resultSource: "model" })), [
    "resolved_clean",
    "model",
  ]);
  // An error the agent fixed on its own is not friction for the person.
  assert.deepEqual(outcome(good({ streaks: 1, failedCalls: 1 }), good()), [
    "resolved_clean",
    "model",
  ]);
});

test("resolved after friction: a turn went wrong or was objected to, and the session ended well", () => {
  // 0.97 -> "still broken. do it again" -> "ok good"
  const corrected = turn({
    result: "completed_wrong",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "corrects",
  });
  assert.deepEqual(outcome(good(), corrected, good()), ["resolved_after_friction", "model"]);
  const failed = turn({
    result: "failed",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "repeats",
    failedCalls: 1,
    streaks: 1,
    cause: "tool_fault",
  });
  assert.deepEqual(outcome(failed, good()), ["resolved_after_friction", "model"]);
});

test("gave up: the session ended without the person getting what they asked for", () => {
  // "stop. I'll do it myself"
  assert.deepEqual(
    outcome(
      good(),
      turn({
        result: "completed_wrong",
        resultSource: "model",
        satisfaction: "unsatisfied",
        reaction: "takes_over",
      }),
    ),
    ["gave_up", "model"],
  );
  assert.deepEqual(
    outcome(
      turn({
        result: "failed",
        resultSource: "model",
        satisfaction: "unsatisfied",
        reaction: "gives_up",
        cause: "tool_fault",
        failedCalls: 5,
        streaks: 1,
      }),
    ),
    ["gave_up", "model"],
  );
  // Nobody complains: the last request simply failed and the session ends.
  assert.deepEqual(outcome(good(), turn({ result: "failed", resultSource: "model", okCalls: 0 })), [
    "gave_up",
    "model",
  ]);
  // The work looked done and the person walked away from it.
  assert.deepEqual(
    outcome(
      turn({
        result: "completed",
        resultSource: "model",
        satisfaction: "unsatisfied",
        reaction: "gives_up",
      }),
    ),
    ["gave_up", "model"],
  );
});

test("blocked: the agent could not do it: no access, no tool for it, or a rule that forbids it", () => {
  // "GitHub PR not found" -> "the PR exists, I'm looking at it right now"
  const noAccess = turn({
    result: "failed",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "corrects",
    cause: "not_allowed",
    okCalls: 0,
    failedCalls: 1,
    streaks: 1,
  });
  assert.deepEqual(outcome(good(), noAccess), ["blocked", "model"]);
  // "export all project data to CSV": nothing in the catalog does it.
  assert.deepEqual(
    outcome(
      turn({
        result: "failed",
        resultSource: "model",
        satisfaction: "unsatisfied",
        reaction: "gives_up",
        cause: "missing_capability",
        okCalls: 0,
      }),
    ),
    ["blocked", "model"],
  );
  assert.deepEqual(
    outcome(
      turn({
        result: "failed",
        resultSource: "model",
        satisfaction: "unsatisfied",
        okCalls: 0,
        unmetSearches: 1,
      }),
    ),
    ["blocked", "model"],
  );
});

test("a correct refusal: the session is blocked when it ends there, and it is not friction on the way", () => {
  const refused = turn({
    result: "refused",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "gives_up",
    cause: "correct_refusal",
    okCalls: 0,
  });
  assert.deepEqual(outcome(good(), refused), ["blocked", "model"]);
  // Refused, the person accepts it and gets the rest done: nothing counts against the agent.
  const accepted = turn({
    result: "refused",
    resultSource: "model",
    satisfaction: "neutral",
    reaction: "new_request",
    cause: "correct_refusal",
    okCalls: 0,
  });
  assert.deepEqual(outcome(accepted, good()), ["resolved_clean", "model"]);
});

test("escalated: the person asked for a human, whatever came after", () => {
  // "I'm telling you there are two. can I talk to a human"
  const asked = turn({
    result: "completed_wrong",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "asks_human",
  });
  assert.deepEqual(outcome(good(), asked), ["escalated", "model"]);
  assert.deepEqual(outcome(asked, good()), ["escalated", "model"]);
});

test("a changed mind on the way is not friction", () => {
  const changedMind = turn({
    result: "completed",
    resultSource: "model",
    satisfaction: "unsatisfied",
    reaction: "new_request",
  });
  assert.deepEqual(outcome(changedMind, good()), ["resolved_clean", "model"]);
  // And a session that ends on one is not unresolved.
  assert.deepEqual(outcome(good(), changedMind), ["resolved_clean", "model"]);
});

test("with rules only, the outcome uses the classes the trace can support and says so", () => {
  assert.deepEqual(
    [...RULE_SESSION_OUTCOMES],
    ["resolved_clean", "resolved_after_friction", "gave_up", "blocked"],
  );
  const clean = turn({ result: "completed", resultSource: "rule" });
  const fixed = turn({
    result: "completed",
    resultSource: "rule",
    okCalls: 2,
    failedCalls: 1,
    streaks: 1,
    cause: "bad_arguments",
  });
  const searched = turn({ result: "failed", resultSource: "rule", okCalls: 0, unmetSearches: 1 });
  const dead = turn({
    result: "failed",
    resultSource: "rule",
    okCalls: 0,
    failedCalls: 2,
    streaks: 1,
    cause: "tool_fault",
  });
  const denied = turn({
    result: "failed",
    resultSource: "rule",
    okCalls: 0,
    failedCalls: 1,
    streaks: 1,
    cause: "not_allowed",
  });

  assert.deepEqual(outcome(clean, clean), ["resolved_clean", "rule"]);
  // A failed call or an unmet search on the way, and the last request closed.
  assert.deepEqual(outcome(fixed, clean), ["resolved_after_friction", "rule"]);
  assert.deepEqual(outcome(searched, clean), ["resolved_after_friction", "rule"]);
  // The last request left open: blocked when the trace shows why the agent could not, else gave up.
  assert.deepEqual(outcome(clean, dead), ["gave_up", "rule"]);
  assert.deepEqual(outcome(clean, denied), ["blocked", "rule"]);
  assert.deepEqual(outcome(clean, searched), ["blocked", "rule"]);
  // A rule-only session is never escalated, and every outcome it can have is one the trace supports.
  for (const turns of [
    [clean],
    [fixed, clean],
    [dead],
    [denied],
    [searched],
    [clean, clean, dead],
  ]) {
    const fused = sessionOutcome(turns);
    assert.equal(fused?.source, "rule");
    assert.ok(RULE_SESSION_OUTCOMES.includes(fused!.outcome));
  }
  // A cause a model read off the search queries does not make the session a model's reading.
  assert.deepEqual(
    outcome(
      clean,
      turn({
        result: "failed",
        resultSource: "rule",
        okCalls: 0,
        unmetSearches: 1,
        cause: "missing_capability",
      }),
    ),
    ["blocked", "rule"],
  );
});

test("with rules only, a session whose last turn is a search nothing was run for is blocked", () => {
  const searched = turn({ result: "failed", resultSource: "rule", okCalls: 0, unmetSearches: 1 });
  assert.deepEqual(outcome(searched), ["blocked", "rule"]);
  assert.deepEqual(outcome(turn({ result: "completed", resultSource: "rule" }), searched), [
    "blocked",
    "rule",
  ]);
  // A call that worked after the search, or a failed call in the turn, is not a missing tool.
  assert.deepEqual(
    outcome(turn({ result: "completed", resultSource: "rule", okCalls: 1, unmetSearches: 1 })),
    ["resolved_after_friction", "rule"],
  );
  assert.deepEqual(
    outcome(
      turn({
        result: "failed",
        resultSource: "rule",
        okCalls: 0,
        failedCalls: 1,
        streaks: 1,
        unmetSearches: 1,
        cause: "tool_fault",
      }),
    ),
    ["gave_up", "rule"],
  );
});

test("one answer about the person's text anywhere in the session makes it a model's reading", () => {
  const clean = turn({ result: "completed", resultSource: "rule" });
  assert.deepEqual(
    outcome(
      clean,
      turn({ result: "completed", resultSource: "rule", satisfaction: "satisfied" }),
      clean,
    ),
    ["resolved_clean", "model"],
  );
  // Rule friction is not the person's friction once their words are read.
  const fixed = turn({
    result: "completed",
    resultSource: "rule",
    okCalls: 2,
    failedCalls: 1,
    streaks: 1,
  });
  assert.deepEqual(outcome(fixed, good()), ["resolved_clean", "model"]);
  // A last turn nothing is known about falls back on the trace: its request was left open.
  assert.deepEqual(outcome(good(), turn({ okCalls: 0, failedCalls: 1, streaks: 1 })), [
    "gave_up",
    "model",
  ]);
});
