/**
 * Golden test: pins the request the fix-draft model sends today, so the
 * provider-neutral model kit (ADR-0009) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { ANALYST_SCHEMA } from "@/lib/synthesis/match-quality/analyst";
import {
  DEFAULT_DRAFT_MODEL,
  DRAFT_FEATURE,
  DRAFT_MAX_TOKENS,
  draftModelFromEnv,
} from "@/lib/views/fix-drafts/model";

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

test("the draft defaults: claude-sonnet-5-5, 1024 tokens, the eval_gate_fix_draft feature", () => {
  assert.equal(DEFAULT_DRAFT_MODEL, "claude-sonnet-5-5");
  assert.equal(DRAFT_MAX_TOKENS, 1024);
  assert.equal(DRAFT_FEATURE, "eval_gate_fix_draft");
});

test("a draft is one Messages request at low effort with the analyst's schema", async () => {
  stubFetch([() => message('{"proposals":[]}')]);
  const model = draftModelFromEnv(cfg(ENV), "production");
  assert.ok(model);
  assert.equal(model.model, "claude-sonnet-5-5");

  const answer = await model.complete({ system: "SYSTEM TEXT", user: "USER TEXT", maxTokens: 777 });

  // The usage handed back is the uncached input alone; the spend line adds the cache tokens.
  assert.deepStrictEqual(answer, {
    text: '{"proposals":[]}',
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-sonnet-5-5",
      max_tokens: 777,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: "USER TEXT" }],
      output_config: { format: { type: "json_schema", schema: ANALYST_SCHEMA }, effort: "low" },
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), okLine("claude-sonnet-5-5", "eval_gate_fix_draft"));
});

test("EVAL_GATE_DRAFT_MODEL names the model sent and the one on the spend line", async () => {
  stubFetch([() => message("{}")]);
  const model = draftModelFromEnv(
    cfg({ ...ENV, EVAL_GATE_DRAFT_MODEL: "claude-opus-5-5" }),
    "production",
  );
  assert.ok(model);
  assert.equal(model.model, "claude-opus-5-5");

  await model.complete({ system: "s", user: "u", maxTokens: DRAFT_MAX_TOKENS });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      output_config: { format: { type: "json_schema", schema: ANALYST_SCHEMA }, effort: "low" },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-opus-5-5", "eval_gate_fix_draft"));
});

test("a server error is tried once (no retries) and recorded as an error", async () => {
  stubFetch([serverError]);
  const model = draftModelFromEnv(cfg(ENV), "production");
  assert.ok(model);

  await assert.rejects(model.complete({ system: "s", user: "u", maxTokens: 10 }));

  assert.equal(sent.length, 1);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-sonnet-5-5", "eval_gate_fix_draft", "InternalServerError"),
  );
});

test("a refusal and a cut-off reply throw after the call is recorded as ok", async () => {
  stubFetch([() => message("", "refusal"), () => message('{"pr', "max_tokens")]);
  const model = draftModelFromEnv(cfg(ENV), "production");
  assert.ok(model);

  await assert.rejects(model.complete({ system: "s", user: "u", maxTokens: 10 }), /refused/);
  await assert.rejects(
    model.complete({ system: "s", user: "u", maxTokens: 10 }),
    /exceeded the output token limit/,
  );

  assert.equal(sent.length, 2);
  assert.deepStrictEqual([lineOf(0).outcome, lineOf(1).outcome], ["ok", "ok"]);
});

test("without a key there is no draft model and nothing is sent", () => {
  stubFetch([() => message("{}")]);
  assert.equal(draftModelFromEnv(cfg({}), "production"), null);
  assert.equal(sent.length, 0);
});
