/**
 * Golden test: pins the requests one tuned decision sends to OpenAI today, so
 * the provider-neutral model kit (ADR-0009) can be proven identical on this
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import {
  DEFAULT_DECISION_FEATURE,
  decisionClient,
  OPENAI_DECISIONS_MODEL,
  OPENAI_DEFAULT_BASE_URL,
  RERANK_DEPTH,
} from "@/lib/readings/decisions/openai";
import {
  choiceResponse,
  noSleep,
  refusalResponse,
  scriptedFetch,
} from "@/lib/readings/decisions/test-helpers";

const FRAMING = { about: "An agent searched.", question: "Which tool next?" };

/** Ten options, so the first answer's top eight are asked again. */
const OPTIONS = [
  { id: "t0", does: "Tool 0", searchable: "Find zero. | Use cases: zero, nil" },
  { id: "t1", does: "Tool 1", searchable: "Tool 1" },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 2}`, does: `Tool ${i + 2}` })),
];

const CHOICES = [
  { value: "t0", description: "What it does: Tool 0\nWhen to use: Find zero." },
  { value: "t1", description: "What it does: Tool 1" },
  { value: "t2", description: "What it does: Tool 2" },
  { value: "t3", description: "What it does: Tool 3" },
  { value: "t4", description: "What it does: Tool 4" },
  { value: "t5", description: "What it does: Tool 5" },
  { value: "t6", description: "What it does: Tool 6" },
  { value: "t7", description: "What it does: Tool 7" },
  { value: "t8", description: "What it does: Tool 8" },
  { value: "t9", description: "What it does: Tool 9" },
];

/** The first answer: t8 and t9 rank last, so the second pass leaves them out. */
const FIRST = {
  t3: 0.4,
  t7: 0.2,
  t1: 0.1,
  t0: 0.08,
  t2: 0.07,
  t4: 0.06,
  t5: 0.05,
  t6: 0.02,
  t8: 0.01,
  t9: 0.01,
};

const HEADERS = { authorization: "Bearer test-key", "content-type": "application/json" };

const body = (input: string, choices: unknown[], model = "gpt-6-luna") => ({
  model,
  input,
  questions: [{ type: "choice", name: "tool", instructions: "Which tool next?", choices }],
});

let restoreSink: () => void = () => {};
let lines: Array<{ fields: Record<string, unknown>; message: string }> = [];

/** The line without its timing, which is checked apart. */
function lineOf(index: number): Record<string, unknown> {
  const { duration_ms: duration, ...fields } = lines[index]!.fields;
  assert.equal(typeof duration, "number");
  assert.equal(lines[index]!.message, "model_call");
  return fields;
}

/** The `model_call` line of one question: input tokens alone, and never Bedrock. */
const okLine = (inputTokens: number, model = "gpt-6-luna", feature = "decision") => ({
  provider: "openai",
  model,
  feature,
  payer: "ratel",
  organization_id: null,
  project_id: null,
  input_tokens: inputTokens,
  output_tokens: null,
  outcome: "ok",
  backend: "api",
});

/** `scriptedFetch`, also keeping each request's method and whether it carries a timeout signal. */
function recordingFetch(responses: Array<Response | Error>) {
  const { fetchImpl, calls } = scriptedFetch(responses);
  const extras: Array<{ method: string | undefined; signal: boolean }> = [];
  const wrapped = ((url: string, init: RequestInit) => {
    extras.push({ method: init.method, signal: init.signal instanceof AbortSignal });
    return fetchImpl(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl: wrapped, calls, extras };
}

beforeEach(() => {
  lines = [];
  restoreSink = setModelCallSink({
    info: (fields, text) => lines.push({ fields, message: text }),
    warn: (fields, text) => lines.push({ fields, message: text }),
  });
});

afterEach(() => {
  restoreSink();
});

test("the defaults: gpt-6-luna on api.openai.com, eight options re-read, the decision feature", () => {
  assert.equal(OPENAI_DECISIONS_MODEL, "gpt-6-luna");
  assert.equal(OPENAI_DEFAULT_BASE_URL, "https://api.openai.com");
  assert.equal(RERANK_DEPTH, 8);
  assert.equal(DEFAULT_DECISION_FEATURE, "decision");
});

test("a decision is two posts: every option, then the first answer's top eight in the same order", async () => {
  const { fetchImpl, calls, extras } = recordingFetch([
    choiceResponse("t3", FIRST, 500),
    choiceResponse("t7", { t7: 0.9, t3: 0.1 }, 400),
  ]);
  const client = decisionClient({ apiKey: "test-key", fetchImpl, sleep: noSleep });
  assert.equal(client.model, "gpt-6-luna");

  const result = await client.decideChoice("find the invoice", OPTIONS, FRAMING);

  assert.equal(result.answer?.choice, "t7");
  assert.equal(result.inputTokens, 900);
  const input = "An agent searched.\n\nSearch query: find the invoice";
  assert.deepStrictEqual(calls, [
    {
      url: "https://api.openai.com/v1/decisions",
      headers: HEADERS,
      body: body(input, CHOICES),
    },
    {
      url: "https://api.openai.com/v1/decisions",
      headers: HEADERS,
      body: body(input, CHOICES.slice(0, 8)),
    },
  ]);
  assert.deepStrictEqual(extras, [
    { method: "POST", signal: true },
    { method: "POST", signal: true },
  ]);
  assert.equal(lines.length, 2);
  assert.deepStrictEqual([lineOf(0), lineOf(1)], [okLine(500), okLine(400)]);
});

test("a refused wording is asked again with the workplace context, then with the name replaced", async () => {
  const { fetchImpl, calls } = recordingFetch([
    refusalResponse(46),
    refusalResponse(47),
    choiceResponse("t0", { t0: 1 }, 100),
  ]);
  const client = decisionClient({ apiKey: "test-key", fetchImpl, sleep: noSleep });
  const few = OPTIONS.slice(0, 2);

  const result = await client.decideChoice("work history for Ana Lima by day", few, FRAMING);

  assert.equal(result.answer?.choice, "t0");
  assert.equal(result.inputTokens, 193);
  const context =
    "Context: a workplace project-management tool. People's names appear in these queries " +
    "because they are teammates, assignees and authors in the workspace. ";
  const plain = "An agent searched.\n\nSearch query: work history for Ana Lima by day";
  assert.deepStrictEqual(
    calls.map((call) => call.body),
    [
      body(plain, CHOICES.slice(0, 2)),
      body(context + plain, CHOICES.slice(0, 2)),
      body(
        "An agent searched.\n\nSearch query: work history for a teammate by day",
        CHOICES.slice(0, 2),
      ),
    ],
  );
  // A refusal is billed, so it is an ok line; eight options or fewer are not asked again.
  assert.deepStrictEqual([lineOf(0), lineOf(1), lineOf(2)], [okLine(46), okLine(47), okLine(100)]);
});

test("the base URL, model, feature and payer given are the ones sent and recorded", async () => {
  const { fetchImpl, calls } = recordingFetch([choiceResponse("t1", { t1: 1 }, 10)]);
  const client = decisionClient({
    apiKey: "test-key",
    baseUrl: "https://gateway.example.com//",
    model: "gpt-custom",
    feature: "tool_picker",
    payer: "customer",
    fetchImpl,
    sleep: noSleep,
  });

  await client.decideChoice("q", OPTIONS.slice(0, 2), FRAMING);

  assert.deepStrictEqual(calls, [
    {
      url: "https://gateway.example.com/v1/decisions",
      headers: HEADERS,
      body: body("An agent searched.\n\nSearch query: q", CHOICES.slice(0, 2), "gpt-custom"),
    },
  ]);
  assert.deepStrictEqual(lineOf(0), {
    ...okLine(10, "gpt-custom", "tool_picker"),
    payer: "customer",
  });
});

test("a server error is tried three times and recorded once as an error", async () => {
  const failure = () => new Response("boom", { status: 500 });
  const { fetchImpl, calls } = recordingFetch([failure(), failure(), failure()]);
  const client = decisionClient({ apiKey: "test-key", fetchImpl, sleep: noSleep });

  await assert.rejects(client.decideChoice("q", OPTIONS.slice(0, 2), FRAMING));

  assert.equal(calls.length, 3);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), {
    provider: "openai",
    model: "gpt-6-luna",
    feature: "decision",
    payer: "ratel",
    organization_id: null,
    project_id: null,
    input_tokens: null,
    output_tokens: null,
    outcome: "error",
    backend: "api",
    error_type: "DecisionCallError",
  });
});
