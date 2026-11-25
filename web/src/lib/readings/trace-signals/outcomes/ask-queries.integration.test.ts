import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClosedQuestionClient } from "@/lib/contracts/closed-questions";
import {
  type AskDeps,
  askQuestions,
  contentHashOf,
  type OutcomeAsk,
  type OutcomeQuestion,
  questionHashOf,
  UNKNOWN_ANSWER,
} from "@/lib/readings/trace-signals/outcomes/ask";
import {
  loadOutcomeVerdicts,
  saveOutcomeVerdicts,
} from "@/lib/readings/trace-signals/outcomes/ask-queries";
import {
  count,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";

/** The model a fake client answers as; the answer cache keeps it beside each answer. */
const SAGE2_MODEL = "closed-question-model";

/**
 * The answer cache against a migrated database, with a fake client: answers
 * are kept by hash, an abstention reads back as unknown, and the same asks a
 * second time make no call.
 */

const SATISFIED: OutcomeQuestion = {
  id: "satisfied",
  version: 1,
  kind: "yesno",
  instructions: "Is the person satisfied?",
};
const REACTION: OutcomeQuestion = {
  id: "reaction",
  version: 1,
  kind: "choice",
  instructions: "What does the person do?",
  options: [{ option: "satisfied" }, { option: "corrects" }],
};

test("answers are kept by content and question hash; an abstention reads back as unknown", async () => {
  const { client, db } = await setupDb();
  const key = (content: string, question: OutcomeQuestion) => ({
    contentHash: contentHashOf(content),
    questionHash: questionHashOf(question),
  });
  await saveOutcomeVerdicts(
    PROJECT_ID,
    SAGE2_MODEL,
    [
      { ...key("I did not say that one", SATISFIED), answer: "no", probability: 0.04 },
      { ...key("I did not say that one", REACTION), answer: "corrects", probability: 0.91 },
      { ...key("hm", SATISFIED), answer: UNKNOWN_ANSWER, probability: 0.47 },
    ],
    db,
  );
  // Saving an answer again changes nothing.
  await saveOutcomeVerdicts(
    PROJECT_ID,
    SAGE2_MODEL,
    [{ ...key("hm", SATISFIED), answer: "yes", probability: 0.99 }],
    db,
  );

  const loaded = await loadOutcomeVerdicts(
    PROJECT_ID,
    [
      key("I did not say that one", SATISFIED),
      key("I did not say that one", REACTION),
      key("hm", SATISFIED),
      key("never asked", SATISFIED),
    ],
    db,
  );
  const answers = new Map(
    loaded.map((row) => [`${row.contentHash}:${row.questionHash}`, [row.answer, row.probability]]),
  );
  const of = (content: string, question: OutcomeQuestion) =>
    answers.get(`${contentHashOf(content)}:${questionHashOf(question)}`);
  assert.equal(loaded.length, 3);
  assert.deepEqual(of("I did not say that one", SATISFIED), ["no", 0.04]);
  assert.deepEqual(of("I did not say that one", REACTION), ["corrects", 0.91]);
  assert.deepEqual(of("hm", SATISFIED), ["unknown", 0.47]);

  // Hashes and closed answers only: no content reaches the table.
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_workflow_verdicts where verdict = 'unclear' and workflow_id is null`,
    ),
    1,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_workflow_verdicts where to_jsonb(trace_workflow_verdicts)::text like '%did not say%'`,
    ),
    0,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from trace_workflow_verdicts where model = 'closed-question-model' and options_hash like 'outcome:%'`,
    ),
    3,
  );
});

test("a second run of the same asks makes no fresh call", async () => {
  const { db } = await setupDb();
  let calls = 0;
  const sage: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async (requests) => {
      calls += 1;
      return {
        answers: requests.map((request) =>
          request.questions.map((question) => ({
            id: question.id,
            answer: question.kind === "yesno" ? null : "corrects",
            probability: 0.5,
            reasoned: false,
          })),
        ),
        inputTokens: 100,
        outputTokens: 0,
      };
    },
  };
  const deps: AskDeps = {
    client: sage,
    loadVerdicts: (projectId, keys) => loadOutcomeVerdicts(projectId, keys, db),
    saveVerdicts: (projectId, model, rows) => saveOutcomeVerdicts(projectId, model, rows, db),
    maxAsks: 100,
    maxTokens: 100_000,
    reasoning: "off",
  };
  const asks: OutcomeAsk[] = [
    { key: "t1:satisfied", question: SATISFIED, content: "no!! not v2" },
    { key: "t1:reaction", question: REACTION, content: "no!! not v2" },
    { key: "t2:satisfied", question: SATISFIED, content: "ok good" },
  ];
  const first = await askQuestions(PROJECT_ID, asks, deps);
  assert.deepEqual([first.fresh, first.cached, calls], [3, 0, 1]);
  const second = await askQuestions(PROJECT_ID, asks, deps);
  assert.deepEqual([second.fresh, second.cached, calls], [0, 3, 1]);
  assert.deepEqual(second.verdicts.get("t1:satisfied"), { answer: "unknown", probability: 0.5 });
  assert.deepEqual(second.verdicts.get("t1:reaction"), { answer: "corrects", probability: 0.5 });
});
