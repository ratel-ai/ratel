import assert from "node:assert/strict";
import { test } from "node:test";
import { type OutcomeVerdict, questionHashOf } from "@/lib/readings/trace-signals/outcomes/ask";
import { REACTIONS } from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  answerRow,
  askKey,
  CAUSE_QUESTION,
  CLAIMS_QUESTION,
  COMPLETED_QUESTION,
  causeAsk,
  describeCalls,
  followUpContent,
  MISUNDERSTOOD_QUESTION,
  modelCauseOf,
  NO_ANSWERS,
  OUTCOME_QUESTIONS,
  type QuestionRuleFacts,
  type QuestionTurn,
  REACTION_QUESTION,
  REQUEST_QUESTION,
  readAnswers,
  SATISFIED_QUESTION,
  SEARCH_RUN_QUESTION,
  satisfactionOf,
  searchRunContent,
  type TurnAnswers,
  turnAsks,
  workContent,
} from "@/lib/readings/trace-signals/outcomes/questions";

/** Invented text throughout. */

const CLEAN: QuestionRuleFacts = { failedCalls: 0, unmetSearches: 0, cause: null };

const turn = (over: Partial<QuestionTurn> = {}): QuestionTurn => ({
  turnId: "t1",
  request: "close the onboarding task",
  calls: [
    { tool: "find_task", outcome: "ok" },
    { tool: "update_task", outcome: "ok" },
  ],
  reply: "Marked ONB-3 Onboarding email copy as Done.",
  previous: null,
  next: "I did not say that one",
  unmetQueries: [],
  ...over,
});

const ids = (t: QuestionTurn, rule: QuestionRuleFacts = CLEAN): string[] =>
  turnAsks(t, rule).map((ask) => ask.question.id);
const contentOf = (
  t: QuestionTurn,
  id: string,
  rule: QuestionRuleFacts = CLEAN,
): string | undefined => turnAsks(t, rule).find((ask) => ask.question.id === id)?.content;

const verdicts = (turnId: string, answers: Record<string, string>): Map<string, OutcomeVerdict> =>
  new Map(
    Object.entries(answers).map(([id, answer]) => [
      `${turnId}:${id}`,
      { answer, probability: 0.9 },
    ]),
  );
const answers = (over: Partial<TurnAnswers>): TurnAnswers => ({ ...NO_ANSWERS, ...over });

test("there are eight questions, each with a fixed wording, fixed answers and a version", () => {
  assert.deepEqual(
    OUTCOME_QUESTIONS.map((question) => question.id),
    [
      "satisfied",
      "reaction",
      "misunderstood",
      "completed",
      "asks",
      "claims",
      "cause",
      "search_run",
    ],
  );
  for (const question of OUTCOME_QUESTIONS) {
    assert.equal(question.version, 1);
    assert.ok(question.instructions.length > 0);
    assert.equal(question.kind === "choice", (question.options?.length ?? 0) >= 2);
  }
  assert.equal(new Set(OUTCOME_QUESTIONS.map(questionHashOf)).size, 8);
});

test("the wordings tried on the mock conversations stay verbatim", () => {
  assert.equal(
    SATISFIED_QUESTION.instructions,
    "A person sent this message to an AI agent that works for them, after the agent did something for them. Is the person satisfied with what the agent did?",
  );
  assert.equal(
    REQUEST_QUESTION.instructions,
    "In their last message, is the person asking the agent to do something: a new request, or to do something again or differently?",
  );
  assert.equal(COMPLETED_QUESTION.instructions, "Did the agent complete what the person asked?");
});

test("the reaction is one choice between seven answers, not tags", () => {
  assert.equal(REACTION_QUESTION.kind, "choice");
  assert.deepEqual(
    REACTION_QUESTION.options?.map((option) => option.option),
    ["satisfied", "corrects", "repeats", "gives_up", "asks_human", "takes_over", "new_request"],
  );
  assert.deepEqual(
    REACTION_QUESTION.options?.map((option) => option.option),
    [...REACTIONS],
  );
  assert.ok(REACTION_QUESTION.options?.every((option) => option.description));
});

test("only the satisfaction question may reason", () => {
  assert.deepEqual(
    OUTCOME_QUESTIONS.filter((question) => question.mayReason).map((question) => question.id),
    ["satisfied"],
  );
});

test("calls read as tool and outcome, a failure with its error", () => {
  assert.equal(describeCalls([]), "nothing");
  assert.equal(
    describeCalls([
      { tool: "find_task", outcome: "ok" },
      { tool: "add_task_comment", outcome: "error", error: "Task not found" },
      { tool: "run_suite", outcome: "unknown" },
    ]),
    "find_task (ok); add_task_comment (error: Task not found); run_suite (no result)",
  );
  assert.equal(
    describeCalls([{ tool: "update_task", outcome: "error", error: null }]),
    "update_task (error: )",
  );
});

test("inputs are built from the turn: the request, the calls with their outcome, the reply and the next message", () => {
  const t = turn();
  const work =
    "The person asked: close the onboarding task\nThe agent did: find_task (ok); update_task (ok)\nThe agent replied: Marked ONB-3 Onboarding email copy as Done.";
  assert.equal(workContent({ request: t.request!, calls: t.calls, reply: t.reply }), work);
  assert.equal(
    followUpContent({ request: t.request!, calls: t.calls, reply: t.reply }, t.next!),
    `${work}\nThe person then said: I did not say that one`,
  );
  // The questions about how the next message takes the turn read the turn and that message.
  for (const id of ["satisfied", "reaction", "misunderstood"])
    assert.equal(contentOf(t, id), `${work}\nThe person then said: I did not say that one`);
  // The question about the turn's own work reads the turn alone.
  assert.equal(contentOf(t, "completed"), work);
});

test("the request question reads the message after the previous request, its calls and its reply", () => {
  const previous = {
    request: "list my open tasks",
    calls: [{ tool: "list_tasks", outcome: "ok" as const }],
    reply: "You have 3 open tasks.",
  };
  assert.equal(
    contentOf(turn({ previous }), "asks"),
    "The person asked: list my open tasks\nThe agent did: list_tasks (ok)\nThe agent replied: You have 3 open tasks.\nThe person then said: close the onboarding task",
  );
  // Without an exchange before it, the message alone.
  assert.equal(contentOf(turn(), "asks"), "close the onboarding task");
});

test("a turn with a next message gets satisfaction, reaction and misunderstanding, though every call succeeded", () => {
  assert.deepEqual(ids(turn()), ["satisfied", "reaction", "misunderstood", "completed", "asks"]);
});

test("the last turn of a session has no next message: only the questions about its own work", () => {
  assert.deepEqual(ids(turn({ next: null })), ["completed", "asks"]);
});

test("the claim question is asked only when the trace went wrong and the reply was captured", () => {
  const failed: QuestionRuleFacts = { failedCalls: 1, unmetSearches: 0, cause: "wrong_reference" };
  assert.ok(ids(turn(), failed).includes("claims"));
  assert.ok(ids(turn(), { failedCalls: 0, unmetSearches: 1, cause: null }).includes("claims"));
  assert.equal(ids(turn(), CLEAN).includes("claims"), false);
  assert.equal(ids(turn({ reply: null }), failed).includes("claims"), false);
});

test("without a captured reply the content has no reply line", () => {
  assert.equal(
    contentOf(turn({ reply: null }), "completed"),
    "The person asked: close the onboarding task\nThe agent did: find_task (ok); update_task (ok)",
  );
});

test("a project with no user text gets only the search-run question", () => {
  const silent = turn({
    request: null,
    reply: null,
    next: null,
    unmetQueries: ["export project to csv", "csv export", "download all tasks"],
  });
  const asks = turnAsks(silent, { failedCalls: 0, unmetSearches: 1, cause: null });
  assert.deepEqual(
    asks.map((ask) => ask.question.id),
    ["search_run"],
  );
  assert.equal(asks[0]!.content, "1. export project to csv\n2. csv export\n3. download all tasks");
  // And a turn with neither user text nor an unmet search run gets nothing.
  assert.deepEqual(turnAsks(turn({ request: null, reply: null, next: null }), CLEAN), []);
});

test("the search-run question needs only the agent's queries", () => {
  assert.equal(searchRunContent(["a", "b"]), "1. a\n2. b");
  assert.equal(SEARCH_RUN_QUESTION.kind, "choice");
  assert.ok(
    ids(turn({ unmetQueries: ["delete task permanently"] }), {
      failedCalls: 0,
      unmetSearches: 1,
      cause: null,
    }).includes("search_run"),
  );
});

test("long text is clipped in the content", () => {
  const long = turn({
    request: "please ".repeat(1_000),
    reply: "Done. ".repeat(1_000),
    next: "thanks ".repeat(1_000),
  });
  const content = contentOf(long, "satisfied")!;
  assert.ok(content.length < 4_700);
  assert.equal(content.split(" […]").length - 1, 3);
});

test("a plain new request counts as neutral, not satisfied", () => {
  assert.equal(satisfactionOf(answers({ satisfied: "yes", reaction: "new_request" })), "neutral");
  assert.equal(
    satisfactionOf(answers({ satisfied: "unknown", reaction: "new_request" })),
    "neutral",
  );
  assert.equal(satisfactionOf(answers({ satisfied: null, reaction: "new_request" })), "neutral");
});

test("satisfaction: unsatisfied needs pushing back; moving on is neutral; a yes with thanks is satisfied", () => {
  assert.equal(satisfactionOf(answers({ satisfied: "no", reaction: "new_request" })), "neutral");
  assert.equal(satisfactionOf(answers({ satisfied: "no", reaction: "corrects" })), "unsatisfied");
  assert.equal(satisfactionOf(answers({ satisfied: "yes", reaction: "corrects" })), "unsatisfied");
  assert.equal(satisfactionOf(answers({ satisfied: "no", reaction: "unknown" })), "unknown");
  assert.equal(satisfactionOf(answers({ satisfied: "no" })), "unknown");
  assert.equal(satisfactionOf(answers({ satisfied: "yes", reaction: "satisfied" })), "satisfied");
  assert.equal(satisfactionOf(answers({ satisfied: "yes", reaction: "unknown" })), "satisfied");
});

test("satisfaction: an undecided answer falls back on the reaction, else it is unknown; nothing asked is null", () => {
  assert.equal(
    satisfactionOf(answers({ satisfied: "unknown", reaction: "satisfied" })),
    "satisfied",
  );
  for (const reaction of ["corrects", "repeats", "gives_up", "asks_human", "takes_over"] as const) {
    assert.equal(satisfactionOf(answers({ satisfied: "unknown", reaction })), "unsatisfied");
  }
  assert.equal(satisfactionOf(answers({ satisfied: "unknown", reaction: "unknown" })), "unknown");
  assert.equal(satisfactionOf(answers({ satisfied: "unknown" })), "unknown");
  assert.equal(satisfactionOf(NO_ANSWERS), null);
});

test("answers are read by turn and question; an answer outside the fixed ones is unknown", () => {
  const read = readAnswers(
    "t1",
    verdicts("t1", {
      satisfied: "no",
      reaction: "corrects",
      misunderstood: "yes",
      completed: "unknown",
      asks: "yes",
      cause: "angry",
    }),
  );
  assert.deepEqual(read, {
    satisfied: "no",
    reaction: "corrects",
    misunderstood: "yes",
    completed: "unknown",
    asks: "yes",
    claims: null,
    cause: "unknown",
    searchRun: null,
  });
  assert.deepEqual(readAnswers("t2", verdicts("t1", { satisfied: "no" })), NO_ANSWERS);
  assert.equal(askKey("t1", SATISFIED_QUESTION), "t1:satisfied");
});

test("the cause is asked only when the turn went wrong and the rules leave it open", () => {
  const unhappy = answers({ satisfied: "no", reaction: "corrects" });
  const ask = causeAsk(turn(), CLEAN, unhappy);
  assert.equal(ask?.question, CAUSE_QUESTION);
  assert.equal(ask?.key, "t1:cause");
  assert.ok(ask?.content.endsWith("The person then said: I did not say that one"));
  // Nothing went wrong: not asked.
  assert.equal(
    causeAsk(turn(), CLEAN, answers({ satisfied: "yes", completed: "yes", misunderstood: "no" })),
    null,
  );
  assert.equal(
    causeAsk(turn(), CLEAN, answers({ satisfied: "yes", reaction: "new_request" })),
    null,
  );
  // Misunderstood or not completed is wrong enough, even with no next message.
  assert.ok(causeAsk(turn(), CLEAN, answers({ misunderstood: "yes" })));
  const last = causeAsk(turn({ next: null }), CLEAN, answers({ completed: "no" }));
  assert.ok(last && !last.content.includes("The person then said"));
});

test("the rules decide wrong arguments, a wrong reference, a tool fault, no access and a missing tool", () => {
  const unhappy = answers({ satisfied: "no", reaction: "corrects" });
  for (const cause of ["bad_arguments", "wrong_reference", "tool_fault", "not_allowed"] as const) {
    assert.equal(causeAsk(turn(), { failedCalls: 2, unmetSearches: 0, cause }, unhappy), null);
  }
  // A search run nothing was run for is a missing tool.
  assert.equal(causeAsk(turn(), { failedCalls: 0, unmetSearches: 1, cause: null }, unhappy), null);
  // An error no pattern knew, or one that could not be read, leaves it open.
  assert.ok(causeAsk(turn(), { failedCalls: 1, unmetSearches: 0, cause: "other" }, unhappy));
  assert.ok(causeAsk(turn(), { failedCalls: 1, unmetSearches: 0, cause: null }, unhappy));
  // No user text: never asked.
  assert.equal(causeAsk(turn({ request: null }), CLEAN, unhappy), null);
});

test("the model's cause: the cause question's answer, else a missing capability from a one-need search run", () => {
  assert.equal(modelCauseOf(answers({ cause: "misread_request" })), "misread_request");
  assert.equal(modelCauseOf(answers({ cause: "none" })), null);
  assert.equal(modelCauseOf(answers({ cause: "unknown" })), null);
  assert.equal(modelCauseOf(answers({ searchRun: "one_need" })), "missing_capability");
  assert.equal(modelCauseOf(answers({ searchRun: "browsing" })), null);
  assert.equal(modelCauseOf(NO_ANSWERS), null);
});

test("a turn's row keeps closed values only", () => {
  const row = answerRow(
    "t1",
    answers({
      satisfied: "no",
      reaction: "corrects",
      claims: "yes",
      asks: "yes",
      cause: "false_success",
    }),
  );
  assert.deepEqual(row, {
    turnId: "t1",
    satisfaction: "unsatisfied",
    reaction: "corrects",
    claimedDone: true,
    request: true,
    cause: "false_success",
  });
  assert.deepEqual(answerRow("t2", answers({ claims: "unknown", asks: "no" })), {
    turnId: "t2",
    satisfaction: null,
    reaction: null,
    claimedDone: null,
    request: false,
    cause: null,
  });
  assert.equal(
    CLAIMS_QUESTION.instructions,
    "Does the agent say that it has done what the person asked?",
  );
  assert.equal(MISUNDERSTOOD_QUESTION.kind, "yesno");
});
