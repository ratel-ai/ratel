import assert from "node:assert/strict";
import { test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import { resolveDecisionEngine, usdPerInputToken } from "./engine";
import type { CorpusEntry, JudgeCase } from "./judge";
import { DecisionCallError, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";
import { judgeFromEnv } from "./resolve";
import { systemOneClient } from "./system-one";

/**
 * The System One engine (ADR-0033 §9): a wire format, configured by a base URL, a model and a
 * key. No vendor is named here; a deployment points it at the server it uses.
 */

interface Seen {
  url: string;
  auth: string | null;
  body: {
    model: string;
    state: string;
    questions: Record<
      string,
      { type: string; instructions: string; criteria: Record<string, string> }
    >;
  };
}

function server(...responses: Array<Response | Error>) {
  const seen: Seen[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    const next = queue.shift();
    if (!next) throw new Error("the fake server has no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The answer a System One server gives to the one `tool` question. */
function answer(probabilities: Record<string, number>, extra: Record<string, unknown> = {}) {
  return json({
    model: "decider-1",
    answers: { tool: { type: "choice", probabilities, ...extra } },
    usage: { input_tokens: 321 },
  });
}

const noSleep = async () => {};
const OPTIONS = [
  { id: "refund", does: "Refund a charge", searchable: "Return money | Use cases: refunds" },
  { id: "list", does: "List charges" },
  { id: "create", does: "Create a charge" },
];
const FRAMING = { about: "A user searched a tool catalog.", question: "Which tool fits?" };

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return systemOneClient({
    baseUrl: "https://decide.test/",
    model: "decider-1",
    apiKey: "key-1",
    fetchImpl,
    sleep: noSleep,
    ...extra,
  });
}

test("one question: the request, and the answer mapped back to the options' ids", async () => {
  const { seen, fetchImpl } = server(answer({ t0: 0.84, t1: 0.15, t2: 0.01 }));
  const result = await client(fetchImpl).decideChoice("I was charged twice", OPTIONS, FRAMING);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://decide.test/v1/systemone");
  assert.equal(seen[0].auth, "Bearer key-1");
  assert.deepEqual(seen[0].body, {
    model: "decider-1",
    state: "A user searched a tool catalog.\n\nSearch query: I was charged twice",
    questions: {
      tool: {
        type: "choice",
        instructions: "Which tool fits?",
        // Index keys, not ids: an id may be long or odd, and the key is part of what is read.
        criteria: {
          t0: "What it does: Refund a charge\nWhen to use: Return money",
          t1: "What it does: List charges",
          t2: "What it does: Create a charge",
        },
      },
    },
  });
  assert.deepEqual(result, {
    answer: {
      choice: "refund",
      confidence: 0.84,
      probabilities: { refund: 0.84, list: 0.15, create: 0.01 },
    },
    inputTokens: 321,
  });
});

test("a server's own choice and confidence are used when it gives them", async () => {
  const { fetchImpl } = server(answer({ t0: 0.5, t1: 0.5 }, { choice: "t1", confidence: 0.61 }));
  const result = await client(fetchImpl).decideChoice("q", OPTIONS.slice(0, 2), FRAMING);
  assert.equal(result.answer?.choice, "list");
  assert.equal(result.answer?.confidence, 0.61);
});

test("a server without a key gets no authorization header", async () => {
  const { seen, fetchImpl } = server(answer({ t0: 0.9, t1: 0.1 }));
  await client(fetchImpl, { apiKey: undefined }).decideChoice("q", OPTIONS.slice(0, 2), FRAMING);
  assert.equal(seen[0].auth, null);
});

test("usage a server does not report is estimated, so a budget still moves", async () => {
  const { fetchImpl } = server(
    json({ answers: { tool: { type: "choice", probabilities: { t0: 0.9, t1: 0.1 } } } }),
  );
  const result = await client(fetchImpl).decideChoice("q", OPTIONS.slice(0, 2), FRAMING);
  assert.ok(result.inputTokens > 20);
});

test("one option is the answer, and nothing is asked", async () => {
  const { seen, fetchImpl } = server();
  const result = await client(fetchImpl).decideChoice("q", OPTIONS.slice(0, 1), FRAMING);
  assert.deepEqual(result, {
    answer: { choice: "refund", confidence: 1, probabilities: { refund: 1 } },
    inputTokens: 0,
  });
  assert.equal(seen.length, 0);
});

test("what it can be relied on for: no refusals, a score until it is measured", () => {
  const { capabilities, model } = client(server().fetchImpl);
  assert.equal(model, "decider-1");
  assert.deepEqual(capabilities, { refusals: false, confidence: "score", maxOptions: 150 });
});

test("failures carry the same reasons as the OpenAI engine's", async () => {
  const rejected = server(json({ error: "bad key" }, 401));
  await assert.rejects(
    client(rejected.fetchImpl).decideChoice("q", OPTIONS, FRAMING),
    (error: unknown) => error instanceof DecisionCallError && error.reason === "credentials",
  );
  assert.equal(rejected.seen.length, 1);

  const busy = server(json({}, 503), json({}, 503), answer({ t0: 1, t1: 0, t2: 0 }));
  assert.equal(
    (await client(busy.fetchImpl).decideChoice("q", OPTIONS, FRAMING)).answer?.choice,
    "refund",
  );
  assert.equal(busy.seen.length, 3);

  const limited = server(json({}, 429));
  await assert.rejects(
    client(limited.fetchImpl).decideChoice("q", OPTIONS, FRAMING),
    (error: unknown) => error instanceof DecisionCallError && error.reason === "rate_limited",
  );

  const waited = server(json({}, 429), answer({ t0: 1, t1: 0, t2: 0 }));
  await client(waited.fetchImpl, { retryRateLimit: true }).decideChoice("q", OPTIONS, FRAMING);
  assert.equal(waited.seen.length, 2);

  // A plan's usage running out is the server being unavailable to us, not a bad key.
  const spent = server(json({}, 402));
  await assert.rejects(
    client(spent.fetchImpl).decideChoice("q", OPTIONS, FRAMING),
    (error: unknown) => error instanceof DecisionCallError && error.reason === "unavailable",
  );
  assert.equal(spent.seen.length, 1);

  const garbled = server(json({ answers: {} }), json({ answers: {} }), json({ answers: {} }));
  await assert.rejects(
    client(garbled.fetchImpl).decideChoice("q", OPTIONS, FRAMING),
    (error: unknown) => error instanceof DecisionCallError && error.reason === "unreadable",
  );
});

test("each question is one spend line", async () => {
  const lines: Record<string, unknown>[] = [];
  const restore = setModelCallSink({
    info: (fields) => void lines.push(fields),
    warn: (fields) => void lines.push(fields),
  });
  try {
    const { fetchImpl } = server(answer({ t0: 0.9, t1: 0.1 }));
    await client(fetchImpl, { feature: "match_quality_judge" }).decideChoice(
      "q",
      OPTIONS.slice(0, 2),
      FRAMING,
    );
  } finally {
    restore();
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].provider, "system-one");
  assert.equal(lines[0].model, "decider-1");
  assert.equal(lines[0].feature, "match_quality_judge");
  assert.equal(lines[0].input_tokens, 321);
  assert.equal(lines[0].outcome, "ok");
});

/* - Which engine the environment selects ----------------------------------- */

const SYSTEM_ONE = {
  DECISION_ENGINE: "system-one",
  DECISION_BASE_URL: "https://decide.test",
  DECISION_MODEL: "decider-1",
  DECISION_API_KEY: "key-1",
};

test("system-one needs its base URL and its model; the key is optional", () => {
  assert.deepEqual(resolveDecisionEngine(SYSTEM_ONE), {
    name: "system-one",
    apiKey: "key-1",
    baseUrl: "https://decide.test",
    model: "decider-1",
  });
  assert.deepEqual(resolveDecisionEngine({ ...SYSTEM_ONE, DECISION_API_KEY: undefined }), {
    name: "system-one",
    apiKey: "",
    baseUrl: "https://decide.test",
    model: "decider-1",
  });
  assert.equal(resolveDecisionEngine({ ...SYSTEM_ONE, DECISION_BASE_URL: undefined }), null);
  assert.equal(resolveDecisionEngine({ ...SYSTEM_ONE, DECISION_MODEL: undefined }), null);
  assert.equal(resolveDecisionEngine({ ...SYSTEM_ONE, DECISION_BASE_URL: "REPLACE_ME" }), null);
});

test("system-one never falls back to the OpenAI key or engine", () => {
  assert.equal(
    resolveDecisionEngine({
      DECISION_ENGINE: "system-one",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://gw.example",
    }),
    null,
  );
  assert.equal(
    resolveDecisionEngine({ ...SYSTEM_ONE, DECISION_API_KEY: undefined, OPENAI_API_KEY: "sk" })
      ?.apiKey,
    "",
  );
});

test("the OpenAI engine takes the DECISION variables ahead of the OpenAI ones", () => {
  assert.deepEqual(
    resolveDecisionEngine({
      DECISION_API_KEY: "sk-decide",
      DECISION_BASE_URL: "https://gw.example/",
      DECISION_MODEL: "gpt-next",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://other.example",
      OPENAI_DECISIONS_MODEL: "gpt-old",
    }),
    { name: "openai", apiKey: "sk-decide", baseUrl: "https://gw.example/", model: "gpt-next" },
  );
  // The OpenAI key is not sent to a server it was not set for.
  assert.equal(
    resolveDecisionEngine({ DECISION_BASE_URL: "https://gw.example", OPENAI_API_KEY: "sk" }),
    null,
  );
  // The model alone moves nothing else.
  assert.deepEqual(
    resolveDecisionEngine({ OPENAI_API_KEY: "sk", OPENAI_DECISIONS_MODEL: "gpt-old" }),
    { name: "openai", apiKey: "sk", baseUrl: "https://api.openai.com", model: "gpt-old" },
  );
});

test("a decision model's price comes from MODEL_PRICES, else the fallback rate", () => {
  assert.equal(usdPerInputToken("openai"), OPENAI_USD_PER_INPUT_TOKEN);
  assert.equal(
    usdPerInputToken("system-one", {
      DECISION_MODEL: "decider-1",
      MODEL_PRICES: JSON.stringify({ "decider-1": { input: 0.05, output: 10 } }),
    }),
    0.05 / 1_000_000,
  );
  // Unpriced: charged high, so a dollar cap allows fewer questions, never more.
  assert.equal(usdPerInputToken("system-one", { DECISION_MODEL: "decider-1" }), 5 / 1_000_000);
});

/* - The judge over it ------------------------------------------------------ */

const entry = (id: string, description: string): CorpusEntry => ({
  entryId: id,
  name: id,
  searchable: description,
  description,
  source: "runtime",
  matchesAgentDescription: false,
  tags: [],
});
const CORPUS = [entry("a", "Alpha tool"), entry("b", "Beta tool")];
const CASE = (id: string): JudgeCase => ({
  id,
  query: "find alpha",
  shortlist: [],
  assumed: "",
  stratum: "disputed",
});

test("the judge runs on system-one, and is strict until the engine is measured", async () => {
  const { seen, fetchImpl } = server(
    answer({ t0: 0.95, t1: 0.05 }),
    answer({ t0: 0.85, t1: 0.15 }),
  );
  const judge = judgeFromEnv(SYSTEM_ONE, {
    feature: "match_quality_judge",
    fetchImpl,
    sleep: noSleep,
  });
  assert.ok(judge);
  assert.equal(judge.model, "decider-1");
  const verdicts = await judge.judge([CASE("1"), CASE("2")], CORPUS);
  assert.equal(seen.length, 2);
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  assert.equal(byId.get("1")?.entryId, "a");
  // 0.85 clears the OpenAI engine's 0.8, but not an unmeasured engine's 0.9.
  assert.equal(byId.get("2")?.entryId, "");
  assert.equal(byId.get("2")?.confidence, 0.85);
});

test("DECISION_MIN_CONFIDENCE sets the threshold once the engine is measured", async () => {
  const { fetchImpl } = server(answer({ t0: 0.85, t1: 0.15 }));
  const judge = judgeFromEnv(
    { ...SYSTEM_ONE, DECISION_MIN_CONFIDENCE: "0.8" },
    { feature: "match_quality_judge", fetchImpl, sleep: noSleep },
  );
  const [verdict] = (await judge?.judge([CASE("1")], CORPUS)) ?? [];
  assert.equal(verdict?.entryId, "a");
});

test("without a usable engine there is no judge", () => {
  assert.equal(judgeFromEnv({}, { feature: "match_quality_judge" }), null);
  assert.equal(
    judgeFromEnv({ DECISION_ENGINE: "system-one" }, { feature: "match_quality_judge" }),
    null,
  );
});
