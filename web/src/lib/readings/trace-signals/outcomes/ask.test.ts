import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import {
  type ClosedQuestionClient,
  ClosedQuestionError,
  type ClosedQuestionReasoning,
  type ClosedQuestionRequest,
  type ClosedQuestionResult,
} from "@/lib/contracts/closed-questions";
import {
  type AskDeps,
  askQuestions,
  contentHashOf,
  type OutcomeAsk,
  type OutcomeQuestion,
  outcomeReasoning,
  questionHashOf,
  type StoredVerdict,
  UNKNOWN_ANSWER,
} from "@/lib/readings/trace-signals/outcomes/ask";
import { clip, replyToSend } from "@/lib/readings/trace-signals/outcomes/question-content";

/** The model a fake client answers as; the answer cache keeps it beside each answer. */
const SAGE2_MODEL = "closed-question-model";

/** A fake client and an in-memory cache: nothing here reaches a model or a database. */

const SATISFIED: OutcomeQuestion = {
  id: "satisfied",
  version: 1,
  kind: "yesno",
  instructions: "Is the person satisfied?",
  mayReason: true,
};
const REACTION: OutcomeQuestion = {
  id: "reaction",
  version: 1,
  kind: "choice",
  instructions: "What does the person do?",
  options: [{ option: "satisfied" }, { option: "corrects" }, { option: "new_request" }],
};

type Reply = (
  request: ClosedQuestionRequest,
  questionId: string,
) => { answer: string | null; probability: number | null } | null;

function fakeClient(reply: Reply, failWith: Array<ClosedQuestionError | null> = []) {
  const calls: Array<{
    requests: readonly ClosedQuestionRequest[];
    reasoning: ClosedQuestionReasoning;
  }> = [];
  const client: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async (requests, reasoning = "off"): Promise<ClosedQuestionResult> => {
      calls.push({ requests, reasoning });
      const failure = failWith[calls.length - 1];
      if (failure) throw failure;
      return {
        answers: requests.map((request) =>
          request.questions.map((question) => {
            const answered = reply(request, question.id);
            return answered ? { id: question.id, ...answered, reasoned: false } : null;
          }),
        ),
        inputTokens: requests.reduce((total, request) => total + request.questions.length * 50, 0),
        outputTokens: 0,
      };
    },
  };
  return { client, calls };
}

function memoryCache() {
  const rows = new Map<string, StoredVerdict>();
  const id = (row: { contentHash: string; questionHash: string }) =>
    `${row.contentHash}:${row.questionHash}`;
  const models = new Set<string>();
  return {
    rows,
    models,
    loadVerdicts: (async (_projectId, keys) =>
      keys.flatMap((key) => rows.get(id(key)) ?? [])) satisfies AskDeps["loadVerdicts"],
    saveVerdicts: (async (_projectId, model, saved) => {
      models.add(model);
      for (const row of saved) if (!rows.has(id(row))) rows.set(id(row), row);
    }) satisfies AskDeps["saveVerdicts"],
  };
}

const deps = (
  client: ClosedQuestionClient | null,
  cache: ReturnType<typeof memoryCache>,
  over: Partial<AskDeps> = {},
): AskDeps => ({
  client,
  loadVerdicts: cache.loadVerdicts,
  saveVerdicts: cache.saveVerdicts,
  maxAsks: 100,
  maxTokens: 100_000,
  reasoning: "off",
  ...over,
});

const ask = (key: string, question: OutcomeQuestion, content: string): OutcomeAsk => ({
  key,
  question,
  content,
});
const yes: Reply = () => ({ answer: "yes", probability: 0.9 });

test("without a key nothing is asked and the cache is not read", async () => {
  const cache = memoryCache();
  let loads = 0;
  const result = await askQuestions("p", [ask("t1:satisfied", SATISFIED, "thanks")], {
    ...deps(null, cache),
    loadVerdicts: async () => {
      loads += 1;
      return [];
    },
  });
  assert.equal(result.verdicts.size, 0);
  assert.deepEqual([result.fresh, result.cached, result.calls, loads], [0, 0, 0, 0]);
});

test("fresh questions are answered, kept, and a second run of the same asks makes no call", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient((_request, id) =>
    id === "satisfied"
      ? { answer: "no", probability: 0.04 }
      : { answer: "corrects", probability: 0.91 },
  );
  const asks = [
    ask("t1:satisfied", SATISFIED, "I did not say that one"),
    ask("t1:reaction", REACTION, "I did not say that one"),
    ask("t2:satisfied", SATISFIED, "ok good"),
  ];

  const first = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual(
    [first.fresh, first.cached, first.calls, first.capped, first.failed],
    [3, 0, 1, 0, 0],
  );
  assert.equal(first.inputTokens, 150);
  assert.deepEqual(first.verdicts.get("t1:satisfied"), { answer: "no", probability: 0.04 });
  assert.deepEqual(first.verdicts.get("t1:reaction"), { answer: "corrects", probability: 0.91 });
  // One request per content: both questions about a message travel together.
  assert.deepEqual(
    calls[0]!.requests.map((request) => request.questions.map((question) => question.id)),
    [["satisfied", "reaction"], ["satisfied"]],
  );
  assert.deepEqual([...cache.models], [SAGE2_MODEL]);

  const second = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual([second.fresh, second.cached, second.calls], [0, 3, 0]);
  assert.equal(calls.length, 1);
  assert.deepEqual(second.verdicts.get("t1:satisfied"), { answer: "no", probability: 0.04 });
});

test("a null answer is stored as unknown and not asked again", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(() => ({ answer: null, probability: 0.47 }));
  const asks = [ask("t1:satisfied", SATISFIED, "hm")];
  const first = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual(first.verdicts.get("t1:satisfied"), {
    answer: UNKNOWN_ANSWER,
    probability: 0.47,
  });
  assert.equal(first.fresh, 1);
  assert.equal([...cache.rows.values()][0]!.answer, "unknown");
  const second = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual(second.verdicts.get("t1:satisfied"), { answer: "unknown", probability: 0.47 });
  assert.equal(calls.length, 1);
});

test("the same question about the same content is asked once, whatever turn it comes from", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(yes);
  const result = await askQuestions(
    "p",
    [
      ask("t1:satisfied", SATISFIED, "thanks"),
      ask("t2:satisfied", SATISFIED, "thanks"),
      ask("t3:satisfied", SATISFIED, "thanks!"),
    ],
    deps(client, cache),
  );
  assert.equal(result.fresh, 2);
  assert.equal(calls[0]!.requests.length, 2);
  assert.equal(result.verdicts.get("t2:satisfied")?.answer, "yes");
});

test("fresh questions stop at the per-run cap, in the order given; the rest wait for the next run", async () => {
  const cache = memoryCache();
  const { client } = fakeClient(yes);
  const asks = Array.from({ length: 10 }, (_, i) =>
    ask(`t${i}:satisfied`, SATISFIED, `message ${i}`),
  );
  const first = await askQuestions("p", asks, deps(client, cache, { maxAsks: 4 }));
  assert.deepEqual([first.fresh, first.capped], [4, 6]);
  assert.deepEqual(
    [...first.verdicts.keys()],
    ["t0:satisfied", "t1:satisfied", "t2:satisfied", "t3:satisfied"],
  );
  const second = await askQuestions("p", asks, deps(client, cache, { maxAsks: 4 }));
  assert.deepEqual([second.cached, second.fresh, second.capped], [4, 4, 2]);
});

test("fresh questions stop at the per-run token cap", async () => {
  const cache = memoryCache();
  const { client } = fakeClient(yes);
  // Each ask is 100 content tokens plus 6 for the wording.
  const asks = Array.from({ length: 5 }, (_, i) =>
    ask(`t${i}:satisfied`, SATISFIED, `${i}`.repeat(400)),
  );
  const result = await askQuestions("p", asks, deps(client, cache, { maxTokens: 320 }));
  assert.deepEqual([result.fresh, result.capped], [3, 2]);
});

test("a cap of zero asks nothing", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(yes);
  const result = await askQuestions(
    "p",
    [ask("t1:satisfied", SATISFIED, "thanks")],
    deps(client, cache, { maxAsks: 0 }),
  );
  assert.deepEqual([result.fresh, result.capped, calls.length], [0, 1, 0]);
});

test("reasoning is off by default", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(yes);
  await askQuestions(
    "p",
    [ask("t1:satisfied", SATISFIED, "thanks"), ask("t1:reaction", REACTION, "thanks")],
    deps(client, cache),
  );
  assert.deepEqual(
    calls.map((call) => call.reasoning),
    ["off"],
  );
  assert.equal(outcomeReasoning(resolveConfig({ env: {} })), "off");
  assert.equal(outcomeReasoning(resolveConfig({ env: { TRACE_OUTCOMES_REASONING: "on" } })), "off");
  assert.equal(
    outcomeReasoning(resolveConfig({ env: { TRACE_OUTCOMES_REASONING: " Auto " } })),
    "auto",
  );
});

test("the setting turns reasoning to auto for the satisfaction question alone", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(yes);
  await askQuestions(
    "p",
    [ask("t1:satisfied", SATISFIED, "thanks"), ask("t1:reaction", REACTION, "thanks")],
    deps(client, cache, { reasoning: "auto" }),
  );
  const sent = calls.map((call) => [
    call.reasoning,
    call.requests.flatMap((request) => request.questions.map((question) => question.id)),
  ]);
  assert.deepEqual(sent, [
    ["off", ["reaction"]],
    ["auto", ["satisfied"]],
  ]);
});

test("a 402 or a 503 stops the asking for the run, keeps what was answered, and does not throw", async () => {
  for (const status of [402, 503]) {
    const cache = memoryCache();
    const { client, calls } = fakeClient(yes, [
      null,
      new ClosedQuestionError("unavailable", "unavailable", status),
    ]);
    // Long contents, so each batch holds a few and the run needs several calls.
    const asks = Array.from({ length: 40 }, (_, i) =>
      ask(`t${i}:satisfied`, SATISFIED, `${i % 10}`.repeat(20_000) + i),
    );
    const result = await askQuestions("p", asks, deps(client, cache, { maxTokens: 10_000_000 }));
    assert.equal(result.stopped, "unavailable");
    assert.equal(calls.length, 2);
    assert.ok(result.fresh > 0);
    assert.equal(result.fresh, cache.rows.size);
    assert.equal(result.fresh + result.failed + result.capped, 40);
  }
});

test("a refused key stops the asking and is told apart from unavailable", async () => {
  const cache = memoryCache();
  const { client } = fakeClient(yes, [new ClosedQuestionError("credentials", "refused", 401)]);
  const result = await askQuestions(
    "p",
    [ask("t1:satisfied", SATISFIED, "thanks")],
    deps(client, cache),
  );
  assert.equal(result.stopped, "credentials");
  assert.deepEqual([result.fresh, result.failed], [0, 1]);
});

test("a question the server could not answer is not kept and is asked again next run", async () => {
  const cache = memoryCache();
  let down = true;
  const { client } = fakeClient((_request, id) =>
    id === "reaction" && down
      ? null
      : { answer: id === "reaction" ? "corrects" : "no", probability: 0.8 },
  );
  const asks = [ask("t1:satisfied", SATISFIED, "no"), ask("t1:reaction", REACTION, "no")];
  const first = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual([first.fresh, first.failed], [1, 1]);
  assert.equal(first.verdicts.has("t1:reaction"), false);
  down = false;
  const second = await askQuestions("p", asks, deps(client, cache));
  assert.deepEqual([second.cached, second.fresh], [1, 1]);
});

test("no call is made once the run is out of time", async () => {
  const cache = memoryCache();
  const { client, calls } = fakeClient(yes);
  const result = await askQuestions(
    "p",
    [ask("t1:satisfied", SATISFIED, "thanks")],
    deps(client, cache, { outOfTime: () => true }),
  );
  assert.deepEqual([calls.length, result.fresh, result.capped], [0, 0, 1]);
});

test("a question's cache key changes with its version, wording and answers, not with reasoning", () => {
  const base = questionHashOf(SATISFIED);
  assert.equal(questionHashOf({ ...SATISFIED, mayReason: false }), base);
  assert.notEqual(questionHashOf({ ...SATISFIED, version: 2 }), base);
  assert.notEqual(questionHashOf({ ...SATISFIED, instructions: "Is the person happy?" }), base);
  assert.notEqual(
    questionHashOf({ ...REACTION, options: [{ option: "satisfied" }, { option: "corrects" }] }),
    questionHashOf(REACTION),
  );
  assert.notEqual(contentHashOf("thanks"), contentHashOf("thanks!"));
});

test("text is clipped before it is sent, with a mark where it was cut", () => {
  assert.equal(clip("  short   reply\n", 100), "short reply");
  const clipped = clip("word ".repeat(400), 60);
  assert.ok(clipped.length <= 60);
  assert.ok(clipped.endsWith(" […]"));
});

test("a reply is sent only for a project with content capture, clipped", () => {
  const reply = "Done. " + "The task is closed. ".repeat(200);
  assert.equal(replyToSend(reply, false), null);
  assert.equal(replyToSend(null, true), null);
  const sent = replyToSend(reply, true, 80);
  assert.ok(sent !== null && sent.length <= 80 && sent.startsWith("Done. The task is closed."));
});
