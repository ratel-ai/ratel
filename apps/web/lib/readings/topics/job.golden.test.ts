/**
 * Golden test: pins the request the topic namer sends today, so the
 * provider-neutral model kit (ADR-0033) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import { DEFAULT_LABEL_MODEL } from "@/lib/readings/model-defaults";
import { anthropicTopicNamer } from "@/lib/readings/topics/job";
import { buildNamePrompt, NAME_SCHEMA, type NamingGroup } from "@/lib/readings/topics/name";

const VARIABLES = ["ANTHROPIC_BACKEND", "ANTHROPIC_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"] as const;
/** The spend line reads the backend from the process, so the process settings are cleared too. */
const ENV = { ANTHROPIC_API_KEY: "test-key" };

interface Sent {
  url: string;
  method: string;
  apiKey: string | null;
  version: string | null;
  contentType: string | null;
  body: unknown;
}

let saved: (string | undefined)[] = [];
let savedFetch: typeof fetch;
let restoreSink: () => void = () => {};
let sent: Sent[] = [];
let lines: Array<{ fields: Record<string, unknown>; message: string }> = [];

/** A fetch that records each request and answers with `answers` in order (the last one repeats). */
function stubFetch(answers: Array<() => Response>): void {
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      apiKey: headers.get("x-api-key"),
      version: headers.get("anthropic-version"),
      contentType: headers.get("content-type"),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers[Math.min(index, answers.length - 1)]!;
    index += 1;
    return answer();
  }) as typeof fetch;
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 5,
};

const message = (text: string, stopReason = "end_turn") =>
  Response.json({
    id: "msg_golden",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: USAGE,
  });

/** A server error the SDK retries at once (`retry-after-ms`), so counting attempts stays fast. */
const serverError = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), {
    status: 500,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });

/** The line without its timing, which is checked apart. */
function lineOf(index: number): Record<string, unknown> {
  const { duration_ms: duration, ...fields } = lines[index]!.fields;
  assert.equal(typeof duration, "number");
  assert.equal(lines[index]!.message, "model_call");
  return fields;
}

/** The `model_call` line of one answered call (the canned usage: 100 input, 30 read from cache, 5 written). */
const okLine = (model: string, feature: string) => ({
  provider: "anthropic",
  model,
  feature,
  payer: "ratel",
  organization_id: null,
  project_id: null,
  input_tokens: 135,
  output_tokens: 20,
  cached_tokens: 30,
  cache_write_tokens: 5,
  outcome: "ok",
  backend: "api",
});

/** The `model_call` line of one failed call: no tokens, the error's class name. */
const errorLine = (model: string, feature: string, errorType: string) => ({
  provider: "anthropic",
  model,
  feature,
  payer: "ratel",
  organization_id: null,
  project_id: null,
  input_tokens: null,
  output_tokens: null,
  outcome: "error",
  backend: "api",
  error_type: errorType,
});

/** The request as it left: the Messages endpoint, the test key, and `body`. */
const request = (body: unknown): Sent => ({
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  apiKey: "test-key",
  version: "2023-06-01",
  contentType: "application/json",
  body,
});

beforeEach(() => {
  saved = VARIABLES.map((name) => process.env[name]);
  for (const name of VARIABLES) delete process.env[name];
  savedFetch = globalThis.fetch;
  sent = [];
  lines = [];
  restoreSink = setModelCallSink({
    info: (fields, text) => lines.push({ fields, message: text }),
    warn: (fields, text) => lines.push({ fields, message: text }),
  });
});

afterEach(() => {
  VARIABLES.forEach((name, index) => {
    if (saved[index] === undefined) delete process.env[name];
    else process.env[name] = saved[index];
  });
  globalThis.fetch = savedFetch;
  restoreSink();
});

const GROUPS: NamingGroup[] = [
  { topicId: "topic-1", name: "Payment status", asks: ["where is my payment"], turns: 3 },
  { topicId: null, name: null, asks: ["rent a crane", "hire a digger"], turns: 2 },
];

const USER_TEXT = [
  'Group 1 (existing, named "Payment status"), 3 turns:',
  "<ask>where is my payment</ask>",
  "",
  "Group 2 (new), 2 turns:",
  "<ask>rent a crane</ask>",
  "<ask>hire a digger</ask>",
].join("\n");

const REPLY = JSON.stringify({
  topics: [
    { name: "Payment status", description: "Where a payment is.", groups: [1] },
    { name: "Equipment rental", description: "Renting site equipment.", groups: [2] },
  ],
});

test("the default name model is claude-sonnet-5-5", () => {
  assert.equal(DEFAULT_LABEL_MODEL, "claude-sonnet-5-5");
});

test("topic names are one Messages request with the name schema and no effort", async () => {
  stubFetch([() => message(REPLY)]);
  const name = anthropicTopicNamer(DEFAULT_LABEL_MODEL, ENV);
  assert.ok(name);

  const named = await name(GROUPS);

  assert.ok(named);
  const { system } = buildNamePrompt(GROUPS);
  assert.match(system, /^You name the topics people ask an AI agent about\./);
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: USER_TEXT }],
      output_config: { format: { type: "json_schema", schema: NAME_SCHEMA } },
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), okLine("claude-sonnet-5-5", "topics_names"));
});

test("the model id given is the one sent and the one on the spend line", async () => {
  stubFetch([() => message(REPLY)]);
  const name = anthropicTopicNamer("claude-haiku-4-5", ENV);
  assert.ok(name);

  await name(GROUPS);

  assert.equal((sent[0]!.body as { model: string }).model, "claude-haiku-4-5");
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-4-5", "topics_names"));
});

test("a server error is tried three times (the SDK's two retries) and recorded once as an error", async () => {
  stubFetch([serverError]);
  const name = anthropicTopicNamer(DEFAULT_LABEL_MODEL, ENV);
  assert.ok(name);

  await assert.rejects(name(GROUPS));

  assert.equal(sent.length, 3);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-sonnet-5-5", "topics_names", "InternalServerError"),
  );
});

test("a refusal and a cut-off reply throw after the call is recorded as ok", async () => {
  stubFetch([() => message("", "refusal"), () => message('{"to', "max_tokens")]);
  const name = anthropicTopicNamer(DEFAULT_LABEL_MODEL, ENV);
  assert.ok(name);

  await assert.rejects(name(GROUPS), /declined by the model's safety filter/);
  await assert.rejects(name(GROUPS), /cut off at the token limit/);

  assert.equal(sent.length, 2);
  assert.deepStrictEqual([lineOf(0).outcome, lineOf(1).outcome], ["ok", "ok"]);
});

test("without a key there is no namer and nothing is sent", () => {
  stubFetch([() => message(REPLY)]);
  assert.equal(anthropicTopicNamer(DEFAULT_LABEL_MODEL, {}), null);
  assert.equal(sent.length, 0);
});
