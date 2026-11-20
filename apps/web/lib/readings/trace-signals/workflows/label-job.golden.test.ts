/**
 * Golden test: pins the request the workflow labeller sends today, so the
 * provider-neutral model kit (ADR-0033) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import { LABEL_SCHEMA } from "@/lib/readings/trace-signals/workflows/label";
import {
  anthropicLabelComplete,
  DEFAULT_LABEL_MODEL,
} from "@/lib/readings/trace-signals/workflows/label-job";

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

const message = (text: string, stopReason = "end_turn") =>
  Response.json({
    id: "msg_golden",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    },
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

beforeEach(() => {
  saved = VARIABLES.map((name) => process.env[name]);
  for (const name of VARIABLES) delete process.env[name];
  process.env.ANTHROPIC_API_KEY = "test-key";
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

test("the default label model is claude-sonnet-5-5", () => {
  assert.equal(DEFAULT_LABEL_MODEL, "claude-sonnet-5-5");
});

test("a workflow label is one Messages request with the label schema and no effort", async () => {
  stubFetch([() => message('{"name":"Triage"}')]);
  const complete = anthropicLabelComplete(DEFAULT_LABEL_MODEL);
  assert.ok(complete);

  const answer = await complete("SYSTEM TEXT", "USER TEXT");

  assert.equal(answer, '{"name":"Triage"}');
  assert.deepStrictEqual(sent, [
    {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      apiKey: "test-key",
      version: "2023-06-01",
      contentType: "application/json",
      body: {
        model: "claude-sonnet-5-5",
        max_tokens: 400,
        system: "SYSTEM TEXT",
        messages: [{ role: "user", content: "USER TEXT" }],
        output_config: {
          format: { type: "json_schema", schema: LABEL_SCHEMA },
        },
      },
    },
  ]);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    feature: "workflow_label",
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
});

test("the model id given is the one sent and the one on the spend line", async () => {
  stubFetch([() => message("{}")]);
  const complete = anthropicLabelComplete("claude-haiku-4-5");
  assert.ok(complete);

  await complete("s", "u");

  assert.equal((sent[0]!.body as { model: string }).model, "claude-haiku-4-5");
  assert.equal(lineOf(0).model, "claude-haiku-4-5");
});

test("a refusal throws after the call is recorded as ok", async () => {
  stubFetch([() => message("", "refusal")]);
  const complete = anthropicLabelComplete(DEFAULT_LABEL_MODEL);
  assert.ok(complete);

  await assert.rejects(complete("s", "u"), /declined by the model's safety filter/);

  assert.equal(sent.length, 1);
  assert.equal(lineOf(0).outcome, "ok");
});

test("a server error is tried three times (the SDK's two retries) and recorded once as an error", async () => {
  stubFetch([serverError]);
  const complete = anthropicLabelComplete(DEFAULT_LABEL_MODEL);
  assert.ok(complete);

  await assert.rejects(complete("s", "u"));

  assert.equal(sent.length, 3);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    feature: "workflow_label",
    payer: "ratel",
    organization_id: null,
    project_id: null,
    input_tokens: null,
    output_tokens: null,
    outcome: "error",
    backend: "api",
    error_type: "InternalServerError",
  });
});

test("without a key there is no completion and nothing is sent", () => {
  delete process.env.ANTHROPIC_API_KEY;
  stubFetch([() => message("{}")]);
  assert.equal(anthropicLabelComplete(DEFAULT_LABEL_MODEL), null);
  assert.equal(sent.length, 0);
});
