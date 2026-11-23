/**
 * Golden test: pins the request the match-quality analyst sends today, so the
 * provider-neutral model kit (ADR-0009) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { ANALYST_SCHEMA, anthropicAnalystDeps, DEFAULT_ANALYST_MODEL } from "./analyst";

const VARIABLES = ["ANTHROPIC_BACKEND", "ANTHROPIC_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"] as const;

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
  process.env.ANTHROPIC_API_KEY = "test-key";
  resetConfigForTests();
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
  resetConfigForTests();
  globalThis.fetch = savedFetch;
  restoreSink();
});

/** One Messages answer as the server-sent events the SDK's stream reads, the text in two deltas. */
function streamed(text: string, stopReason = "end_turn"): Response {
  const half = Math.ceil(text.length / 2);
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_golden",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...USAGE, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(0, half) },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(half) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("the default analyst model is claude-opus-5-5", () => {
  assert.equal(DEFAULT_ANALYST_MODEL, "claude-opus-5-5");
});

test("an analysis is one streamed Messages request at xhigh effort with the analyst schema", async () => {
  stubFetch([() => streamed('{"diagnosis":{},"proposals":[]}')]);
  const deps = anthropicAnalystDeps(DEFAULT_ANALYST_MODEL);
  assert.equal(deps.model, "claude-opus-5-5");

  const answer = await deps.complete("SYSTEM TEXT", "USER TEXT");

  assert.equal(answer, '{"diagnosis":{},"proposals":[]}');
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: "USER TEXT" }],
      output_config: {
        format: { type: "json_schema", schema: ANALYST_SCHEMA },
        effort: "xhigh",
      },
      stream: true,
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), okLine("claude-opus-5-5", "match_quality_analyst"));
});

test("the model id given is the one sent and the one on the spend line, effort unchanged", async () => {
  stubFetch([() => streamed("{}")]);
  const deps = anthropicAnalystDeps("claude-haiku-4-5");

  await deps.complete("s", "u");

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-4-5",
      max_tokens: 64000,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      output_config: {
        format: { type: "json_schema", schema: ANALYST_SCHEMA },
        effort: "xhigh",
      },
      stream: true,
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-4-5", "match_quality_analyst"));
});

test("a server error is tried three times (the SDK's two retries) and recorded once as an error", async () => {
  stubFetch([serverError]);
  const deps = anthropicAnalystDeps(DEFAULT_ANALYST_MODEL);

  await assert.rejects(deps.complete("s", "u"));

  assert.equal(sent.length, 3);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-opus-5-5", "match_quality_analyst", "InternalServerError"),
  );
});

test("a cut-off answer and a refusal throw after the call is recorded as ok", async () => {
  stubFetch([() => streamed('{"di', "max_tokens"), () => streamed("", "refusal")]);
  const deps = anthropicAnalystDeps(DEFAULT_ANALYST_MODEL);

  await assert.rejects(deps.complete("s", "u"), /hit the 64000-token output cap/);
  await assert.rejects(deps.complete("s", "u"), /declined by the model's safety filter/);

  assert.equal(sent.length, 2);
  assert.deepStrictEqual([lineOf(0).outcome, lineOf(1).outcome], ["ok", "ok"]);
});

test("without a key the deps throw and nothing is sent", () => {
  delete process.env.ANTHROPIC_API_KEY;
  resetConfigForTests();
  stubFetch([() => streamed("{}")]);
  assert.throws(() => anthropicAnalystDeps(DEFAULT_ANALYST_MODEL), /No Claude backend/);
  assert.equal(sent.length, 0);
});
