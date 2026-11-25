/**
 * Golden test: pins the request the engine's cluster namer sends today, so the
 * provider-neutral model kit (ADR-0009) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { NAMES_KEYS_SCHEMA, NAMES_SCHEMA } from "@/lib/readings/intent-engine/names";
import { anthropicNamesComplete, nameModel } from "@/lib/readings/intent-engine/names-job";
import { DEFAULT_LABEL_MODEL } from "@/lib/readings/model-defaults";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

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
let timeouts: (string | null)[] = [];

/** A fetch that records each request and answers with `answers` in order (the last one repeats). */
function stubFetch(answers: Array<() => Response>): void {
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    timeouts.push(headers.get("x-stainless-timeout"));
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
  timeouts = [];
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

test("the default name model is claude-sonnet-5-5, after the three env settings in order", () => {
  assert.equal(DEFAULT_LABEL_MODEL, "claude-sonnet-5-5");
  assert.equal(nameModel(cfg({})), "claude-sonnet-5-5");
  assert.equal(
    nameModel(
      cfg({
        INTENT_ENGINE_NAME_MODEL: "a",
        TOPICS_LABEL_MODEL: "b",
        TRACE_WORKFLOW_LABEL_MODEL: "c",
      }),
    ),
    "a",
  );
  assert.equal(nameModel(cfg({ TOPICS_LABEL_MODEL: "b", TRACE_WORKFLOW_LABEL_MODEL: "c" })), "b");
  assert.equal(nameModel(cfg({ TRACE_WORKFLOW_LABEL_MODEL: "c" })), "c");
});

test("names alone: one Messages request at low effort with the names schema", async () => {
  stubFetch([() => message('{"names":[]}')]);
  const complete = anthropicNamesComplete(DEFAULT_LABEL_MODEL, cfg(ENV));
  assert.ok(complete);

  const answer = await complete("SYSTEM TEXT", "USER TEXT", false);

  assert.equal(answer, '{"names":[]}');
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: "USER TEXT" }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: NAMES_SCHEMA },
      },
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), okLine("claude-sonnet-5-5", "intent_names"));
});

test("names with keys: the same request with the keyed schema", async () => {
  stubFetch([() => message('{"names":[]}')]);
  const complete = anthropicNamesComplete("claude-haiku-4-5", cfg(ENV));
  assert.ok(complete);

  await complete("SYSTEM TEXT", "USER TEXT", true);

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-4-5",
      max_tokens: 16000,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: "USER TEXT" }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: NAMES_KEYS_SCHEMA },
      },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-4-5", "intent_names"));
});

test("the client waits 60 seconds for a call", async () => {
  stubFetch([() => message("{}")]);
  const complete = anthropicNamesComplete(DEFAULT_LABEL_MODEL, cfg(ENV));
  assert.ok(complete);

  await complete("s", "u", false);

  // The one place the client's timeout shows: the SDK's own header, in seconds.
  assert.deepStrictEqual(timeouts, ["60"]);
});

test("a server error is tried twice (one retry) and recorded once as an error", async () => {
  stubFetch([serverError]);
  const complete = anthropicNamesComplete(DEFAULT_LABEL_MODEL, cfg(ENV));
  assert.ok(complete);

  await assert.rejects(complete("s", "u", false));

  assert.equal(sent.length, 2);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-sonnet-5-5", "intent_names", "InternalServerError"),
  );
});

test("a refusal and a cut-off reply each throw their own error after the call is recorded as ok", async () => {
  stubFetch([() => message("", "refusal"), () => message('{"na', "max_tokens")]);
  const complete = anthropicNamesComplete(DEFAULT_LABEL_MODEL, cfg(ENV));
  assert.ok(complete);

  await assert.rejects(complete("s", "u", false), { name: "NamesDeclinedError" });
  await assert.rejects(complete("s", "u", false), { name: "NamesCutOffError" });

  assert.equal(sent.length, 2);
  assert.deepStrictEqual([lineOf(0).outcome, lineOf(1).outcome], ["ok", "ok"]);
});

test("without a key there is no completion and nothing is sent", () => {
  stubFetch([() => message("{}")]);
  assert.equal(anthropicNamesComplete(DEFAULT_LABEL_MODEL, cfg({})), null);
  assert.equal(sent.length, 0);
});
