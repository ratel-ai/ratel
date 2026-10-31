import assert from "node:assert/strict";
import { test } from "node:test";
import { type CorpusEntry, type JudgeCase, TOOL_SEARCH_ABOUT, TOOL_SEARCH_QUESTION } from "./judge";
import { OpenAIJudgeAuthError, openaiJudgeEngine } from "./openai-judge";
import { choiceResponse, noSleep, refusalResponse, scriptedFetch } from "./test-helpers";

const entry = (
  id: string,
  description: string,
  runtimeSearchable?: string,
  searchable = description,
): CorpusEntry => ({
  entryId: id,
  name: id,
  searchable,
  description,
  runtimeSearchable,
  source: "runtime",
  matchesAgentDescription: false,
  tags: [],
});

const CORPUS = [
  entry("a", "Alpha tool", "Find alpha", "OPERATOR OVERRIDE TEXT"),
  entry("b", "Beta tool"),
];
const CASE = (id: string, query = "find alpha"): JudgeCase => ({
  id,
  query,
  shortlist: [],
  assumed: "",
  stratum: "disputed",
});

test("judges with the tuned framing over tool identity, never operator overrides", async () => {
  const { fetchImpl, calls } = scriptedFetch([choiceResponse("a", { a: 0.95, b: 0.05 })]);
  const engine = openaiJudgeEngine({ apiKey: "k", fetchImpl, sleep: noSleep });
  const [verdict] = await engine.judge([CASE("1")], CORPUS);

  assert.deepEqual(verdict, {
    id: "1",
    entryId: "a",
    confident: true,
    confidence: 0.95,
    runnerUp: "b",
  });
  const body = calls[0]!.body as {
    input: string;
    questions: Array<{ instructions: string; choices: Array<{ description: string }> }>;
  };
  assert.ok(body.input.startsWith(TOOL_SEARCH_ABOUT));
  assert.equal(body.questions[0]?.instructions, TOOL_SEARCH_QUESTION.question);
  const text = body.questions[0]!.choices.map((c) => c.description).join("\n");
  assert.match(text, /Find alpha/);
  assert.doesNotMatch(text, /OPERATOR OVERRIDE/);
});

test("abstains below 0.8 and keeps the leaning as the runner-up", async () => {
  const { fetchImpl } = scriptedFetch([choiceResponse("b", { a: 0.4, b: 0.6 })]);
  const [verdict] = await openaiJudgeEngine({ apiKey: "k", fetchImpl, sleep: noSleep }).judge(
    [CASE("1")],
    CORPUS,
  );
  assert.equal(verdict?.entryId, "");
  assert.equal(verdict?.runnerUp, "b");
});

test("a refused ask is an abstention, not a failure", async () => {
  const { fetchImpl } = scriptedFetch([refusalResponse(), refusalResponse()]);
  const verdicts = await openaiJudgeEngine({ apiKey: "k", fetchImpl, sleep: noSleep }).judge(
    [CASE("1", "plain")],
    CORPUS,
  );
  assert.deepEqual(verdicts, [{ id: "1", entryId: "", confident: false }]);
});

test("a custom framing replaces the tuned one (workflows, topics)", async () => {
  const { fetchImpl, calls } = scriptedFetch([choiceResponse("a", { a: 0.9, b: 0.1 })]);
  await openaiJudgeEngine({
    apiKey: "k",
    fetchImpl,
    sleep: noSleep,
    framing: { about: "A user asked.", question: "Which workflow?" },
  }).judge([CASE("1")], CORPUS);
  const body = calls[0]!.body as { input: string; questions: Array<{ instructions: string }> };
  assert.ok(body.input.startsWith("A user asked."));
  assert.equal(body.questions[0]?.instructions, "Which workflow?");
});

test("a rejected key fails the run", async () => {
  const { fetchImpl } = scriptedFetch([new Response("no", { status: 401 })]);
  await assert.rejects(
    openaiJudgeEngine({ apiKey: "k", fetchImpl, sleep: noSleep, concurrency: 1 }).judge(
      [CASE("1"), CASE("2")],
      CORPUS,
    ),
    OpenAIJudgeAuthError,
  );
});

test("stops asking once the token budget is spent", async () => {
  const { fetchImpl, calls } = scriptedFetch([choiceResponse("a", { a: 0.9, b: 0.1 }, 500)]);
  const verdicts = await openaiJudgeEngine({
    apiKey: "k",
    fetchImpl,
    sleep: noSleep,
    concurrency: 1,
    maxInputTokens: 100,
  }).judge([CASE("1"), CASE("2"), CASE("3")], CORPUS);
  assert.equal(calls.length, 1);
  assert.equal(verdicts.length, 1);
});

test("capacity is positive and shrinks with the budget", () => {
  const big = openaiJudgeEngine({ apiKey: "k", maxInputTokens: 10_000_000 }).capacity!(CORPUS);
  const small = openaiJudgeEngine({ apiKey: "k", maxInputTokens: 100_000 }).capacity!(CORPUS);
  assert.ok(big > small && small > 0);
});
