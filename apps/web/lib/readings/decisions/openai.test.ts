import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDecisionRequest,
  catalogText,
  DecisionCallError,
  decisionClient,
  mergeRerank,
  OPENAI_DECISIONS_MODEL,
  optionDescription,
  RERANK_DEPTH,
  redactPeople,
  refusalChain,
  withoutUseCases,
} from "@/lib/readings/decisions/openai";
import {
  choiceResponse,
  noSleep,
  refusalResponse,
  scriptedFetch,
} from "@/lib/readings/decisions/test-helpers";

const FRAMING = { about: "An agent searched.", question: "Which tool next?" };
const TWO = [
  { id: "a", does: "Alpha tool", searchable: "Find alpha. | Use cases: alpha, a" },
  { id: "b", does: "Beta tool" },
];
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, does: `Tool ${i}` }));

test("the keyword tail is dropped from the searchable text", () => {
  assert.equal(withoutUseCases("Find alpha. | Use cases: alpha, a"), "Find alpha.");
  assert.equal(withoutUseCases("No tail here"), "No tail here");
});

test("an option reads what it does, and when to use it only when that adds something", () => {
  assert.equal(optionDescription(TWO[0]!), "What it does: Alpha tool\nWhen to use: Find alpha.");
  assert.equal(optionDescription(TWO[1]!), "What it does: Beta tool");
  assert.equal(
    optionDescription({ id: "c", does: "Same", searchable: "Same" }),
    "What it does: Same",
  );
});

test("the request is one choice question with every option in the order given", () => {
  const body = buildDecisionRequest(
    { input: "in", instructions: "q", options: TWO },
    OPENAI_DECISIONS_MODEL,
  );
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.input, "in");
  const [question] = body.questions as Array<{
    type: string;
    name: string;
    choices: Array<{ value: string }>;
  }>;
  assert.equal(question?.type, "choice");
  assert.equal(question?.name, "tool");
  assert.deepEqual(
    question?.choices.map((c) => c.value),
    ["a", "b"],
  );
});

test("redaction replaces a full name after a person lead-in and keeps the rest of the query", () => {
  const cases: Array<[string, string]> = [
    [
      "Retrieve coding work history for William Cai by calendar day",
      "Retrieve coding work history for a teammate by calendar day",
    ],
    ["tasks assigned to Patrick Metzger", "tasks assigned to a teammate"],
    ["commits by Ana Lima this week", "commits by a teammate this week"],
    ["show PRs created by Sam Ortiz", "show PRs created by a teammate"],
    [
      "issues reported by Sam Ortiz, owned by Ana Lima",
      "issues reported by a teammate, owned by a teammate",
    ],
    ["For John Smith list open tasks", "For a teammate list open tasks"],
    ["history for Jean-Luc Picard", "history for a teammate"],
    ["tasks for Zoë Müller", "tasks for a teammate"],
    ["notes by Conan O'Brien", "notes by a teammate"],
    ["tasks for Patrick Metzger and Ana Lima", "tasks for a teammate and a teammate"],
    [
      "tasks for Ana Lima, Sam Ortiz and Jean-Luc Picard",
      "tasks for a teammate, a teammate and a teammate",
    ],
  ];
  for (const [query, expected] of cases) assert.equal(redactPeople(query), expected, query);
});

test("redaction leaves tool, product, status and project names alone", () => {
  const untouched = [
    "Create Pull Request for RAT-405",
    "Search Jira Tasks by keyword",
    "List GitHub Issues in Ratel Cloud",
    "open the Design Review Board",
    "move task to In Progress",
    "export report to Google Sheets",
    "sync with Slack Channel",
    "update status of Acme Sync",
    "notes about Q3 Planning",
    "Link Pull Request To Task",
    "search tasks by keyword",
    "what did Will do yesterday",
    "",
  ];
  for (const query of untouched) assert.equal(redactPeople(query), query, query);
});

test("redaction needs a lead-in and a two-word capitalised name, so these stay as written", () => {
  // Without a lead-in the screen has nothing to fire on; without a full name nothing is identifying.
  assert.equal(redactPeople("assignees: Patrick Metzger"), "assignees: Patrick Metzger");
  assert.equal(redactPeople("tasks for Patrick"), "tasks for Patrick");
  assert.equal(redactPeople("tasks for patrick metzger"), "tasks for patrick metzger");
  assert.equal(redactPeople("tasks for PATRICK METZGER"), "tasks for PATRICK METZGER");
});

test("a capitalised phrase the catalog itself uses is a product or field, never a person", () => {
  const catalog = catalogText([
    {
      id: "list_tasks",
      does: "List tasks in Ratel Cloud",
      searchable: "Sort by Due Date, Created Date or Priority.",
    },
    { id: "jira_sync", does: "Jira Cloud Sync status" },
  ]);
  assert.equal(redactPeople("tasks for Ratel Cloud", catalog), "tasks for Ratel Cloud");
  assert.equal(
    redactPeople("sort tasks by Due Date for Ana Lima", catalog),
    "sort tasks by Due Date for a teammate",
  );
  assert.equal(
    redactPeople("PRs by Ana Lima and Jira Cloud Sync", catalog),
    "PRs by a teammate and Jira Cloud Sync",
  );
  assert.equal(
    redactPeople("tasks for Ana Lima and Sam Ortiz", catalog),
    "tasks for a teammate and a teammate",
  );
  // Without a catalog the phrase cannot be told from a name, so the conservative choice stands.
  assert.equal(redactPeople("tasks for Ratel Cloud"), "tasks for a teammate");
});

test("the chain checks names against the options it is deciding between", () => {
  const options = [{ id: "cloud", does: "Everything about Ratel Cloud" }];
  const chain = refusalChain("usage for Ratel Cloud by Ana Lima", FRAMING, options);
  assert.equal(chain.length, 4);
  assert.ok(chain[2]!.input.endsWith("Search query: usage for Ratel Cloud by a teammate"));
});

test("the refusal chain tries the query as written, then with context, then the same two redacted", () => {
  const chain = refusalChain("history for William Cai", FRAMING);
  assert.deepEqual(
    chain.map((c) => c.input),
    [
      "An agent searched.\n\nSearch query: history for William Cai",
      "Context: a workplace project-management tool. People's names appear in these queries " +
        "because they are teammates, assignees and authors in the workspace. " +
        "An agent searched.\n\nSearch query: history for William Cai",
      "An agent searched.\n\nSearch query: history for a teammate",
      "Context: a workplace project-management tool. People's names appear in these queries " +
        "because they are teammates, assignees and authors in the workspace. " +
        "An agent searched.\n\nSearch query: history for a teammate",
    ],
  );
  assert.ok(chain.every((c) => c.instructions === FRAMING.question && c.options.length === 0));
});

test("a query with no name has two wordings, both carrying it verbatim", () => {
  const chain = refusalChain("Create Pull Request for RAT-405", FRAMING);
  assert.equal(chain.length, 2);
  assert.ok(chain.every((c) => c.input.endsWith("Search query: Create Pull Request for RAT-405")));
});

test("a small option set is decided in one call", async () => {
  const { fetchImpl, calls } = scriptedFetch([choiceResponse("a", { a: 0.9, b: 0.1 }, 321)]);
  const client = decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep });
  const result = await client.decideChoice("find alpha", TWO, FRAMING);
  assert.equal(result.answer?.choice, "a");
  assert.equal(result.inputTokens, 321);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/decisions");
  assert.equal(calls[0]?.headers.authorization, "Bearer k");
});

test("a large option set is re-read over its top options, which decide the order", async () => {
  const options = many(12);
  const firstProbs = Object.fromEntries(options.map((o, i) => [o.id, (12 - i) / 100]));
  const { fetchImpl, calls } = scriptedFetch([
    choiceResponse("t0", firstProbs, 1000),
    choiceResponse(
      "t3",
      { t0: 0.2, t1: 0.05, t2: 0.05, t3: 0.6, t4: 0.04, t5: 0.03, t6: 0.02, t7: 0.01 },
      200,
    ),
  ]);
  const client = decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep });
  const result = await client.decideChoice("q", options, FRAMING);

  const reread = (calls[1]?.body.questions as Array<{ choices: Array<{ value: string }> }>)[0]!
    .choices;
  assert.equal(reread.length, RERANK_DEPTH);
  assert.deepEqual(
    reread.map((c) => c.value),
    ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"],
  );
  assert.equal(result.answer?.choice, "t3");
  assert.equal(result.answer?.confidence, 0.6);
  assert.equal(result.inputTokens, 1200);
  // Options outside the re-read set still rank, but below every re-read one.
  const probs = result.answer!.probabilities;
  assert.ok(probs.t8! > 0 && probs.t8! < probs.t7!);
});

test("a refused query is first retried as written with context, and the tokens of every call are counted", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    refusalResponse(46),
    choiceResponse("a", { a: 0.7, b: 0.3 }, 300),
  ]);
  const client = decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep });
  const result = await client.decideChoice("history for William Cai", TWO, FRAMING);
  assert.equal(result.answer?.choice, "a");
  assert.equal(result.inputTokens, 346);
  assert.equal(calls.length, 2);
  const retry = String(calls[1]?.body.input);
  assert.match(retry, /^Context:/);
  assert.match(retry, /William Cai/, "the name is still there: context alone was tried first");
  assert.doesNotMatch(retry, /a teammate/);
});

test("the name is only redacted once the context wording is refused too", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    refusalResponse(),
    refusalResponse(),
    choiceResponse("a", { a: 0.7, b: 0.3 }),
  ]);
  await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "history for William Cai",
    TWO,
    FRAMING,
  );
  assert.equal(calls.length, 3);
  const third = String(calls[2]?.body.input);
  assert.doesNotMatch(third, /^Context:/);
  assert.match(third, /history for a teammate/);
});

test("a named query refused under all four wordings is null, with every call's tokens counted", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    refusalResponse(40),
    refusalResponse(50),
    refusalResponse(40),
    refusalResponse(50),
  ]);
  const result = await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "history for William Cai",
    TWO,
    FRAMING,
  );
  assert.equal(result.answer, null);
  assert.equal(result.inputTokens, 180);
  assert.equal(calls.length, 4);
});

test("a query naming a tool is never reworded into a different query", async () => {
  const { fetchImpl, calls } = scriptedFetch([refusalResponse(), refusalResponse()]);
  const result = await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "Create Pull Request for RAT-405",
    TWO,
    FRAMING,
  );
  assert.equal(result.answer, null);
  assert.equal(calls.length, 2);
  for (const call of calls)
    assert.match(String(call.body.input), /Create Pull Request for RAT-405$/);
});

test("a product named in the catalog survives redaction end to end", async () => {
  const options = [
    { id: "a", does: "Alpha tool", searchable: "Reports for Ratel Cloud" },
    { id: "b", does: "Beta tool" },
  ];
  const { fetchImpl, calls } = scriptedFetch([
    refusalResponse(),
    refusalResponse(),
    choiceResponse("a", { a: 0.9, b: 0.1 }),
  ]);
  await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "report for Ratel Cloud by Ana Lima",
    options,
    FRAMING,
  );
  assert.match(String(calls[2]?.body.input), /report for Ratel Cloud by a teammate$/);
});

test("the re-read uses the wording that got through, not the one that was refused", async () => {
  const options = many(12);
  const probs = Object.fromEntries(options.map((o, i) => [o.id, (12 - i) / 100]));
  const { fetchImpl, calls } = scriptedFetch([
    refusalResponse(),
    choiceResponse("t0", probs),
    choiceResponse("t0", probs),
  ]);
  await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "history for William Cai",
    options,
    FRAMING,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.body.input, calls[1]?.body.input);
  assert.match(String(calls[2]?.body.input), /^Context:/);
});

test("when every wording is refused the answer is null, not an error", async () => {
  const { fetchImpl } = scriptedFetch([refusalResponse(), refusalResponse()]);
  const client = decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep });
  const result = await client.decideChoice("plain query", TWO, FRAMING);
  assert.equal(result.answer, null);
  assert.equal(result.inputTokens, 92);
});

test("no re-read when the first answer carries no probabilities", async () => {
  const options = many(12);
  const { fetchImpl, calls } = scriptedFetch([choiceResponse("t1", {}, 500)]);
  const result = await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "q",
    options,
    FRAMING,
  );
  assert.equal(calls.length, 1);
  assert.equal(result.answer?.choice, "t1");
  assert.equal(result.inputTokens, 500);
});

test("a refused re-read keeps the first answer", async () => {
  const options = many(10);
  const { fetchImpl } = scriptedFetch([
    choiceResponse("t1", Object.fromEntries(options.map((o) => [o.id, 0.1]))),
    refusalResponse(),
  ]);
  const result = await decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice(
    "q",
    options,
    FRAMING,
  );
  assert.equal(result.answer?.choice, "t1");
});

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof DecisionCallError ? err.reason : `other: ${String(err)}`;
  }
  return "resolved";
}

test("a rejected key fails at once, without retries", async () => {
  const { fetchImpl, calls } = scriptedFetch([new Response("no", { status: 401 })]);
  const client = decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep });
  assert.equal(await reasonOf(client.decideChoice("q", TWO, FRAMING)), "credentials");
  assert.equal(calls.length, 1);
});

test("a 429 throws unless the caller waits rate limits out", async () => {
  const fast = scriptedFetch([new Response("slow down", { status: 429 })]);
  assert.equal(
    await reasonOf(
      decisionClient({ apiKey: "k", fetchImpl: fast.fetchImpl, sleep: noSleep }).decideChoice(
        "q",
        TWO,
        FRAMING,
      ),
    ),
    "rate_limited",
  );
  const patient = scriptedFetch([
    new Response("slow down", { status: 429 }),
    choiceResponse("b", { a: 0.2, b: 0.8 }),
  ]);
  const result = await decisionClient({
    apiKey: "k",
    fetchImpl: patient.fetchImpl,
    sleep: noSleep,
    retryRateLimit: true,
  }).decideChoice("q", TWO, FRAMING);
  assert.equal(result.answer?.choice, "b");
});

test("a 5xx or dropped connection is retried; a 4xx is not", async () => {
  const flaky = scriptedFetch([
    new Response("boom", { status: 503 }),
    new TypeError("socket hang up"),
    choiceResponse("a", { a: 1 }),
  ]);
  const ok = await decisionClient({
    apiKey: "k",
    fetchImpl: flaky.fetchImpl,
    sleep: noSleep,
  }).decideChoice("q", TWO, FRAMING);
  assert.equal(ok.answer?.choice, "a");

  const bad = scriptedFetch([new Response("bad shape", { status: 400 })]);
  assert.equal(
    await reasonOf(
      decisionClient({ apiKey: "k", fetchImpl: bad.fetchImpl, sleep: noSleep }).decideChoice(
        "q",
        TWO,
        FRAMING,
      ),
    ),
    "unavailable",
  );
  assert.equal(bad.calls.length, 1);
});

test("a choice that was not offered is unreadable", async () => {
  const { fetchImpl } = scriptedFetch([choiceResponse("zzz", { zzz: 1 })]);
  assert.equal(
    await reasonOf(
      decisionClient({ apiKey: "k", fetchImpl, sleep: noSleep }).decideChoice("q", TWO, FRAMING),
    ),
    "unreadable",
  );
});

test("mergeRerank: re-read options keep their scores, the rest rank strictly below", () => {
  const merged = mergeRerank(
    { choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.3, c: 0.15, d: 0.05 } },
    { choice: "b", confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } },
  );
  assert.equal(merged.choice, "b");
  assert.equal(merged.probabilities.b, 0.7);
  assert.ok(merged.probabilities.c! < 0.3 && merged.probabilities.d! < merged.probabilities.c!);
});
