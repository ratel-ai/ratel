import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ClosedQuestionClient,
  type ClosedQuestionRequest,
} from "@/lib/contracts/closed-questions";
import type { AskDeps, StoredVerdict } from "@/lib/readings/trace-signals/outcomes/ask";
import {
  isStatusCheck,
  type ModelReadDeps,
  type ModelTurn,
  mergeSessionMessages,
  messageTurnId,
  questionTurns,
  readModelLayer,
  type SessionMessage,
  satisfactionByLexicon,
  templateMessages,
} from "@/lib/readings/trace-signals/outcomes/model-read";

/** The model a fake client answers as; the answer cache keeps it beside each answer. */
const SAGE2_MODEL = "closed-question-model";

/** A fake client, an in-memory cache and invented conversations: nothing here reaches a model or a database. */

const RANGE = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z") };
const at = (minute: number) => new Date(Date.parse("2026-09-01T09:00:00Z") + minute * 60_000);

const message = (
  sessionId: string,
  turnId: string,
  minute: number,
  text: string,
): SessionMessage => ({ sessionId, turnId, at: at(minute), text, traceId: `trace-${turnId}` });

const modelTurn = (
  turnId: string,
  sessionId: string,
  declared: string | null,
  over: Partial<ModelTurn> = {},
): ModelTurn => ({
  turnId,
  sessionId,
  turnKey: declared === null ? `inferred:${turnId}` : `declared:${declared}`,
  startedAt: at(0),
  calls: [{ tool: "update_task", outcome: "ok" }],
  unmetSearchEvents: [],
  searchEvents: [],
  rule: { failedCalls: 0, unmetSearches: 0, cause: null },
  ...over,
});

/** s1: a request, a correction, a thanks with no call after it. */
const MESSAGES = [
  message("s1", "a", 0, "close the onboarding task"),
  message("s1", "b", 2, "I did not say that one. reopen it"),
  message("s1", "c", 4, "ok good, thanks"),
];
const TURNS = [modelTurn("t-a", "s1", "a"), modelTurn("t-b", "s1", "b")];
const REPLIES = new Map([
  ["trace-a", "Marked ONB-3 as Done."],
  ["trace-b", "Reopened ONB-3."],
]);

test("a turn's inputs come from its session: its message, its reply, the exchange before and the message after", () => {
  const [first, second] = questionTurns(TURNS, MESSAGES, REPLIES, new Map(), RANGE);
  assert.deepEqual(first, {
    turnId: "t-a",
    request: "close the onboarding task",
    calls: [{ tool: "update_task", outcome: "ok" }],
    reply: "Marked ONB-3 as Done.",
    previous: null,
    next: "I did not say that one. reopen it",
    unmetQueries: [],
  });
  assert.deepEqual(second!.previous, {
    request: "close the onboarding task",
    calls: [{ tool: "update_task", outcome: "ok" }],
    reply: "Marked ONB-3 as Done.",
  });
  // The thanks ran no call, so it is no turn of the ledger; it is still what the person said next.
  assert.equal(second!.next, "ok good, thanks");
});

test("a message with no call after it is an exchange with no calls; one before the window is not told", () => {
  const messages = [
    message("s1", "z", -24 * 60 - 30, "an older request"),
    message("s1", "a", 0, "what can you do?"),
    message("s1", "b", 2, "create a task for the SSL cert"),
  ];
  const [turn] = questionTurns(
    [modelTurn("t-b", "s1", "b")],
    messages,
    new Map(),
    new Map(),
    RANGE,
  );
  assert.deepEqual(turn!.previous, { request: "what can you do?", calls: [], reply: null });
  const [early] = questionTurns(
    [modelTurn("t-a", "s1", "a")],
    messages,
    new Map(),
    new Map(),
    RANGE,
  );
  assert.equal(early!.previous, null);
});

test("a reply is read only when the project captures content", () => {
  const [turn] = questionTurns(TURNS, MESSAGES, new Map(), new Map(), RANGE);
  assert.equal(turn!.reply, null);
});

test("a turn the SDK declared no message for has no user text; its unmet searches still read", () => {
  const turns = [
    modelTurn("t-x", "s9", null, {
      unmetSearchEvents: ["e1", "e2", "e-gone"],
      rule: { failedCalls: 0, unmetSearches: 1, cause: null },
    }),
  ];
  const [turn] = questionTurns(
    turns,
    [],
    new Map(),
    new Map([
      ["e1", "export project to csv"],
      ["e2", "csv export"],
    ]),
    RANGE,
  );
  assert.equal(turn!.request, null);
  assert.deepEqual(turn!.unmetQueries, ["export project to csv", "csv export"]);
});

type Answer = (request: ClosedQuestionRequest, questionId: string) => string | null;

function fakes(
  answer: Answer,
  over: Partial<AskDeps> = {},
  texts: {
    messages?: SessionMessage[];
    replies?: Map<string, string>;
    queries?: Map<string, string>;
  } = {},
) {
  const calls: ClosedQuestionRequest[][] = [];
  const cache = new Map<string, StoredVerdict>();
  const loads = { messages: 0, replies: 0, queries: 0 };
  const client: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async (requests) => {
      calls.push([...requests]);
      return {
        answers: requests.map((request) =>
          request.questions.map((question) => ({
            id: question.id,
            answer: answer(request, question.id),
            probability: 0.9,
            reasoned: false,
          })),
        ),
        inputTokens: 10,
        outputTokens: 0,
      };
    },
  };
  const deps: ModelReadDeps = {
    ask: {
      client,
      loadVerdicts: async (_projectId, keys) =>
        keys.flatMap((key) => cache.get(`${key.contentHash}:${key.questionHash}`) ?? []),
      saveVerdicts: async (_projectId, _model, rows) => {
        for (const row of rows) cache.set(`${row.contentHash}:${row.questionHash}`, row);
      },
      maxAsks: 100,
      maxTokens: 100_000,
      reasoning: "off",
      ...over,
    },
    loadMessages: async () => {
      loads.messages += 1;
      return texts.messages ?? MESSAGES;
    },
    loadReplies: async () => {
      loads.replies += 1;
      return texts.replies ?? REPLIES;
    },
    loadQueries: async () => {
      loads.queries += 1;
      return texts.queries ?? new Map();
    },
  };
  const asked = () =>
    calls.flatMap((requests) =>
      requests.flatMap((request) => request.questions.map((question) => question.id)),
    );
  return { deps, calls, loads, asked };
}

/** The first turn was misread and corrected; the second was fine. */
const corrected: Answer = (request, id) => {
  const followUp = request.content.includes("I did not say that one");
  const aboutFirst = request.content.startsWith("The person asked: close the onboarding task");
  if (id === "satisfied") return aboutFirst && followUp ? "no" : "yes";
  if (id === "reaction") return aboutFirst && followUp ? "corrects" : "satisfied";
  if (id === "misunderstood") return aboutFirst && followUp ? "yes" : "no";
  if (id === "completed") return "yes";
  if (id === "asks") return "yes";
  if (id === "cause") return "misread_request";
  return null;
};

test("without a key nothing is loaded or asked and the result is null", async () => {
  const { deps, loads, calls } = fakes(corrected);
  const result = await readModelLayer(
    "p",
    TURNS,
    { range: RANGE, sessions: true },
    { ...deps, ask: { ...deps.ask, client: null } },
  );
  assert.equal(result, null);
  assert.deepEqual([loads.messages, loads.replies, loads.queries, calls.length], [0, 0, 0, 0]);
});

test("a cap of zero turns the questions off", async () => {
  const { deps, loads } = fakes(corrected, { maxAsks: 0 });
  assert.equal(await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps), null);
  assert.equal(loads.messages, 0);
});

test("three passes: every turn's questions, the cause where the answers say it went wrong, then each task's question", async () => {
  const { deps, asked } = fakes(corrected);
  const result = await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps);
  assert.ok(result);
  // Five questions per turn in the first pass, one cause question in the second for the corrected turn only,
  // and in the third one task question per task: both turns were read as requests, so each is a task.
  assert.deepEqual(asked().sort(), [
    "asks",
    "asks",
    "cause",
    "completed",
    "completed",
    "misunderstood",
    "misunderstood",
    "reaction",
    "reaction",
    "satisfied",
    "satisfied",
    "task_done",
    "task_done",
  ]);
  assert.deepEqual(result.rows, [
    {
      turnId: "t-a",
      satisfaction: "unsatisfied",
      reaction: "corrects",
      claimedDone: null,
      request: true,
      cause: "misread_request",
    },
    {
      turnId: "t-b",
      satisfaction: "satisfied",
      reaction: "satisfied",
      claimedDone: null,
      request: true,
      cause: null,
    },
  ]);
  assert.deepEqual(result.stored, {
    version: 1,
    turnsWithText: 2,
    turnsAnswered: 2,
    fresh: 13,
    cached: 0,
    capped: 0,
    failed: 0,
    calls: 3,
    inputTokens: 30,
    stopped: null,
    tasksAsked: 2,
    satisfactionByLexicon: 0,
    templates: 0,
  });
  assert.deepEqual([...result.tasks.keys()].sort(), ["t-a", "t-b"]);
});

test("a second reading of the same turns asks nothing fresh", async () => {
  const { deps, calls } = fakes(corrected);
  const first = await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps);
  const made = calls.length;
  const second = await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps);
  assert.equal(calls.length, made);
  assert.deepEqual([second!.stored.fresh, second!.stored.cached, second!.stored.calls], [0, 13, 0]);
  assert.deepEqual(second!.rows, first!.rows);
});

test("every pass shares one cap", async () => {
  const { deps, asked } = fakes(corrected, { maxAsks: 10 });
  const result = await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps);
  // The first pass takes all ten; the cause question and the two task questions wait for the next run.
  assert.equal(asked().length, 10);
  assert.equal(asked().includes("cause"), false);
  assert.equal(asked().includes("task_done"), false);
  assert.deepEqual([result!.stored.fresh, result!.stored.capped], [10, 3]);
  assert.equal(result!.rows[0]!.cause, null);
});

/**
 * `n` sessions of one objected-to turn each, and a server that answers every
 * question but `misunderstood`, which comes back `ok: false` (no answer).
 * Every turn's answers say it went wrong, so every turn wants a cause.
 */
function unanswering(n: number, maxAsks: number) {
  const messages = Array.from({ length: n }, (_, i) => [
    message(`s${i}`, `a${i}`, 0, `close task ${i}`),
    message(`s${i}`, `b${i}`, 2, `not task ${i}, the other one`),
  ]).flat();
  const turns = Array.from({ length: n }, (_, i) => modelTurn(`t-${i}`, `s${i}`, `a${i}`));
  const sent: string[] = [];
  const cache = new Map<string, StoredVerdict>();
  const yes = new Map([
    ["satisfied", "no"],
    ["reaction", "corrects"],
    ["completed", "yes"],
    ["asks", "yes"],
    ["cause", "misread_request"],
  ]);
  const client: ClosedQuestionClient = {
    model: SAGE2_MODEL,
    decide: async () => {
      throw new Error("not used");
    },
    decideBatch: async (requests) => ({
      answers: requests.map((request) =>
        request.questions.map((question) => {
          sent.push(question.id);
          const answer = yes.get(question.id);
          // What the client hands back for an answer the server marked `ok: false`.
          return answer === undefined
            ? null
            : { id: question.id, answer, probability: 0.9, reasoned: false };
        }),
      ),
      inputTokens: 10,
      outputTokens: 0,
    }),
  };
  const deps: ModelReadDeps = {
    ask: {
      client,
      loadVerdicts: async (_projectId, keys) =>
        keys.flatMap((key) => cache.get(`${key.contentHash}:${key.questionHash}`) ?? []),
      saveVerdicts: async (_projectId, _model, rows) => {
        for (const row of rows) cache.set(`${row.contentHash}:${row.questionHash}`, row);
      },
      maxAsks,
      maxTokens: 1_000_000,
      reasoning: "off",
    },
    loadMessages: async () => messages,
    loadReplies: async () => new Map(),
    loadQueries: async () => new Map(),
  };
  return { deps, turns, sent };
}

test("questions the server does not answer count against the cap: the first pass fills it, the cause pass sends nothing", async () => {
  // Six turns of five questions each against a cap of 20: four turns' worth go out, one of each five unanswered.
  const { deps, turns, sent } = unanswering(6, 20);
  const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
  assert.equal(sent.length, 20);
  assert.equal(sent.includes("cause"), false);
  assert.deepEqual([result!.stored.fresh, result!.stored.failed], [16, 4]);
  assert.ok(result!.stored.fresh + result!.stored.failed <= 20);
});

test("questions the server does not answer count against the cap: the cause pass gets only what is left", async () => {
  // Three turns, 15 questions sent of which 3 unanswered, against a cap of 17: two cause questions fit, the third and the three task questions wait.
  const { deps, turns, sent } = unanswering(3, 17);
  const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
  assert.equal(sent.length, 17);
  assert.equal(sent.filter((id) => id === "cause").length, 2);
  assert.deepEqual(
    [result!.stored.fresh, result!.stored.failed, result!.stored.capped],
    [14, 3, 4],
  );
});

test("the questions sent in one run never exceed the cap, whatever the server leaves unanswered", async () => {
  for (const cap of [1, 4, 5, 6, 11, 15, 16, 19, 20, 22, 29, 30, 31, 36, 40, 42, 45]) {
    const { deps, turns, sent } = unanswering(6, cap);
    const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
    assert.ok(sent.length <= cap, `cap ${cap}: sent ${sent.length}`);
    assert.equal(result!.stored.fresh + result!.stored.failed, sent.length);
    // With room for everything: 30 in the first pass, the six causes, then the six task questions.
    if (cap >= 42) assert.equal(sent.length, 42);
  }
});

test("a project with no user text is asked only about its search runs, and no message is loaded", async () => {
  const turns = [
    modelTurn("t-x", "s9", null, {
      calls: [],
      unmetSearchEvents: ["e1", "e2"],
      rule: { failedCalls: 0, unmetSearches: 1, cause: null },
    }),
    modelTurn("t-y", "s9", null),
  ];
  const { deps, asked, loads } = fakes(
    () => "one_need",
    {},
    {
      queries: new Map([
        ["e1", "delete task permanently"],
        ["e2", "remove task forever"],
      ]),
    },
  );
  const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
  assert.deepEqual(asked(), ["search_run"]);
  assert.deepEqual([loads.messages, loads.replies, loads.queries], [0, 0, 1]);
  assert.deepEqual(result!.rows, [
    {
      turnId: "t-x",
      satisfaction: null,
      reaction: null,
      claimedDone: null,
      request: null,
      cause: "missing_capability",
    },
  ]);
  assert.deepEqual([result!.stored.turnsWithText, result!.stored.turnsAnswered], [0, 1]);
});

test("where sessions are not one person's, neighbours are not read: no user-text question", async () => {
  const { deps, asked, loads } = fakes(corrected);
  const result = await readModelLayer("p", TURNS, { range: RANGE, sessions: false }, deps);
  assert.deepEqual(asked(), []);
  assert.equal(loads.messages, 0);
  assert.deepEqual(result!.rows, []);
});

test("a failed call with a captured reply adds the claim question", async () => {
  const turns = [
    modelTurn("t-a", "s1", "a", {
      calls: [{ tool: "add_task_comment", outcome: "error", error: "Task not found" }],
      rule: { failedCalls: 1, unmetSearches: 0, cause: "wrong_reference" },
    }),
  ];
  const { deps, calls, asked } = fakes((_request, id) =>
    id === "claims" ? "yes" : id === "completed" ? "no" : "yes",
  );
  const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
  assert.ok(asked().includes("claims"));
  // The rules decided the cause (a wrong reference): the cause question is not asked.
  assert.equal(asked().includes("cause"), false);
  assert.equal(result!.rows[0]!.claimedDone, true);
  const work = calls
    .flat()
    .find((request) => request.questions.some((question) => question.id === "claims"))!.content;
  assert.equal(
    work,
    "The person asked: close the onboarding task\nThe agent did: add_task_comment (error: Task not found)\nThe agent replied: Marked ONB-3 as Done.",
  );
});

test("without the person's words, a turn that searched is a task with its searches as the goal; a turn with no search is not asked", async () => {
  const turns = [
    modelTurn("t-s", "s7", null, {
      searchEvents: ["q1", "q2"],
      calls: [{ tool: "add_task_comment", outcome: "ok" }],
    }),
    modelTurn("t-n", "s7", null, { calls: [{ tool: "filter_tasks", outcome: "ok" }] }),
  ];
  const contents: string[] = [];
  const { deps, asked } = fakes(
    (request, id) => {
      if (id === "task_done") contents.push(request.content);
      return id === "task_done" ? "not_achieved" : "none";
    },
    {},
    {
      queries: new Map([
        ["q1", "update task status to done"],
        ["q2", "mark task complete"],
      ]),
    },
  );
  const result = await readModelLayer("p", turns, { range: RANGE, sessions: true }, deps);
  assert.deepEqual(asked(), ["task_done"]);
  assert.equal(
    contents[0],
    "Goal, as the agent searched its tools for it:\n1. update task status to done\n2. mark task complete\nThe agent did: add_task_comment (ok)",
  );
  assert.deepEqual([...result!.tasks], [["t-s", { answer: "not_achieved", probability: 0.9 }]]);
  assert.equal(result!.stored.tasksAsked, 1);
});

test("a turn whose person's message was not sent is asked what the next reply shows about it", async () => {
  const turns = [
    modelTurn("t-1", "s8", null, { calls: [{ tool: "manage_project", outcome: "ok" }] }),
    modelTurn("t-2", "s8", null),
  ];
  const contents: string[] = [];
  const { deps, asked } = fakes((request, id) => {
    if (id === "reply_reaction") contents.push(request.content);
    return id === "reply_reaction" ? "corrects" : "none";
  });
  const nextReplies = new Map([["t-1", "Restored v2 and archived the 2024 one instead."]]);
  const result = await readModelLayer(
    "p",
    turns,
    { range: RANGE, sessions: true, nextReplies },
    deps,
  );
  assert.deepEqual(asked(), ["reply_reaction"]);
  assert.equal(
    contents[0],
    "The agent did: manage_project (ok)\nThen the person sent a message. The agent replied: Restored v2 and archived the 2024 one instead.",
  );
  assert.deepEqual([...result!.replyReactions], [["t-1", "corrects"]]);
});

test("an OTel run's prompt is the person's message of its turn, paired by the run's own key", () => {
  const otlp = (turnId: string, traceId: string): ModelTurn =>
    modelTurn(turnId, "s9", null, { turnKey: `otlp:${traceId}` });
  const prompts = [
    {
      sessionId: "s9",
      turnId: "otlp:t1",
      traceId: "t1",
      at: at(0),
      text: "rename the onboarding board",
    },
    {
      sessionId: "s9",
      turnId: "otlp:t2",
      traceId: "t2",
      at: at(3),
      text: "that's wrong, I meant the sales board",
    },
  ];
  const [first, second] = questionTurns(
    [otlp("r-1", "t1"), otlp("r-2", "t2")],
    prompts,
    new Map(),
    new Map(),
    RANGE,
  );
  assert.equal(first!.request, "rename the onboarding board");
  assert.equal(first!.next, "that's wrong, I meant the sales board");
  assert.equal(second!.previous?.request, "rename the onboarding board");
  assert.equal(messageTurnId("inferred:x"), null, "a turn with no message of its own gets none");
});

test("the lexicon reads the next message where the questions left satisfaction open", async () => {
  assert.equal(satisfactionByLexicon("thanks, perfect"), "satisfied");
  assert.equal(satisfactionByLexicon("that's wrong, still not working"), "unsatisfied");
  assert.equal(
    satisfactionByLexicon("now archive the old tasks"),
    null,
    "a plain request says nothing about the last reply",
  );
  assert.equal(satisfactionByLexicon(null), null);

  // The cap leaves room for no satisfaction question: the second turn's next message ("ok good, thanks") is read by the lexicon.
  const { deps } = fakes(() => null);
  const result = await readModelLayer("p", TURNS, { range: RANGE, sessions: true }, deps);
  const row = result!.rows.find((entry) => entry.turnId === "t-b");
  assert.equal(row?.satisfaction, "satisfied");
  assert.notEqual(
    result!.answers.get("t-b")?.satisfied,
    "yes",
    "the lexicon never feeds the fusion",
  );
  assert.equal(
    result!.stored.satisfactionByLexicon,
    1,
    "the first turn's next message is plain: no reading",
  );
});

test("a message whose opening recurs across sessions is machine-written, and nobody's reaction", async () => {
  const nudge = (sessionId: string) =>
    `You stopped before handing off RC-${sessionId} to review. Pick it up.`;
  const messages = [
    ...["s1", "s2", "s3"].map((sessionId, i) =>
      message(sessionId, `n${i}`, 10 + i, nudge(sessionId)),
    ),
    message("s4", "x", 0, "You stopped before handing off the report, can you finish it"),
    message("s1", "p", 20, "rename the onboarding board for me please"),
  ];
  const templates = templateMessages(messages);
  assert.deepEqual(
    [...templates].sort(),
    [nudge("s1"), nudge("s2"), nudge("s3")].sort(),
    "three sessions, one opening",
  );
  assert.equal(templates.has("rename the onboarding board for me please"), false);

  // A nudge after a turn is not how the person took it: no satisfaction question and no lexicon reading.
  const { deps, asked } = fakes(
    () => "no",
    {},
    { messages: [message("s1", "a", 0, "close the onboarding task"), ...messages] },
  );
  const result = await readModelLayer(
    "p",
    [modelTurn("t-a", "s1", "a")],
    { range: RANGE, sessions: true },
    deps,
  );
  assert.equal(asked().includes("satisfied"), false);
  assert.equal(result!.rows.find((row) => row.turnId === "t-a")?.satisfaction ?? null, null);
  assert.equal(result!.stored.templates, 3);
});

test("for satisfaction the lexicon reads clear phrases only", () => {
  assert.equal(satisfactionByLexicon("can we make sure this never happens again?"), null);
  assert.equal(satisfactionByLexicon("try again, it's still not working"), "unsatisfied");
});

test("a project that sends both lanes sends each message twice: the scope's message wins", () => {
  const scoped = [
    message("s1", "a", 0, "close the onboarding task"),
    message("s1", "b", 2, "thanks"),
  ];
  const prompts = [
    {
      sessionId: "s1",
      turnId: "otlp:trace-a",
      traceId: "trace-a",
      at: at(0),
      text: "close the onboarding task",
    },
    {
      sessionId: "s1",
      turnId: "otlp:trace-z",
      traceId: "trace-z",
      at: at(5),
      text: "archive the old ones",
    },
  ];
  assert.deepEqual(
    mergeSessionMessages(scoped, prompts).map((entry) => entry.turnId),
    ["a", "b", "otlp:trace-z"],
  );
});

test("tool notices and templates with changing names and ids are machine-written", () => {
  const messages = [
    message(
      "s1",
      "a",
      0,
      "[beluga] rstagi's agent replied (task t_79, which you sent earlier in this conversation)",
    ),
    message(
      "s1",
      "b",
      1,
      "Pull request #496 (https://github.com/x/y/pull/496) has merge conflicts with main, so GitHub can't merge it.",
    ),
    message(
      "s2",
      "c",
      1,
      "Pull request #521 (https://github.com/x/y/pull/521) has merge conflicts with main, so GitHub can't merge it.",
    ),
    message(
      "s3",
      "d",
      1,
      "Pull request #531 (https://github.com/x/y/pull/531) has merge conflicts with main, so GitHub can't merge it.",
    ),
    message("s4", "e", 1, "can we understand why maybe? I would like to know more"),
  ];
  assert.deepEqual([...templateMessages(messages)].length, 4);
  assert.equal(
    templateMessages(messages).has("can we understand why maybe? I would like to know more"),
    false,
  );
});

test("a short check on progress is waiting, not pushing back", () => {
  for (const text of [
    "How is it going?",
    "how is training going?",
    "when is it gonna done",
    "What is the situation",
    "continue",
    "keep going",
    "is training promising?",
    "did progress stop?",
    "How are the results?",
  ]) {
    assert.equal(isStatusCheck(text), true, text);
  }
  for (const text of [
    "you wasted my 10 hours",
    "did you commit the changes?",
    "how is it going to work on production with the old flags?",
  ]) {
    assert.equal(isStatusCheck(text), false, text);
  }
});
