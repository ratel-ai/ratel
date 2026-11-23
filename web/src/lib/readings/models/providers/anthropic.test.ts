import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetConfigForTests, resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { anthropicClient } from "@/lib/readings/anthropic/client";
import { models } from "../index";
import { anthropicProvider, anthropicTextModel } from "./anthropic";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

/**
 * The Claude adapter must send what the call sites sent before it existed; their golden tests
 * prove that site by site. These pin the adapter's own rules.
 */

interface Sent {
  url: string;
  apiKey: string | null;
  timeout: string | null;
  body: Record<string, unknown>;
}

const ENV = { ANTHROPIC_API_KEY: "test-key" };
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 5,
};

let realFetch: typeof fetch;
let restoreSink: () => void = () => {};
let savedBackend: string | undefined;
let sent: Sent[] = [];
let lines: Record<string, unknown>[] = [];
let answers: Array<() => Response> = [];

function message(text: string, stop = "end_turn"): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [
          { type: "thinking", thinking: "…", signature: "sig" },
          { type: "text", text },
        ],
        stop_reason: stop,
        stop_sequence: null,
        usage: USAGE,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function failure(status: number): () => Response {
  return () =>
    new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "no" } }), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
}

function stream(text: string): () => Response {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...USAGE, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  sent = [];
  lines = [];
  answers = [];
  savedBackend = process.env.ANTHROPIC_BACKEND;
  delete process.env.ANTHROPIC_BACKEND;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push({
      url: request.url,
      apiKey: request.headers.get("x-api-key"),
      timeout: request.headers.get("x-stainless-timeout"),
      body: JSON.parse(await request.text()),
    });
    const next = answers.shift();
    if (!next) throw new Error("the fake API has no answer left");
    return next();
  }) as typeof fetch;
  restoreSink = setModelCallSink({
    info: (fields) => void lines.push(fields),
    warn: (fields) => void lines.push(fields),
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreSink();
  if (savedBackend === undefined) delete process.env.ANTHROPIC_BACKEND;
  else process.env.ANTHROPIC_BACKEND = savedBackend;
});

function text(model = "claude-sonnet-5-5") {
  const built = anthropicTextModel({
    model,
    feature: "workflow_label",
    payer: "ratel",
    config: cfg(ENV),
  });
  assert.ok(built);
  return built;
}

const SCHEMA = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

test("a schema and an effort ride in output_config; the answer is the text blocks", async () => {
  answers.push(message('{"name":"x"}'));
  const model = text();
  const reply = await model.complete({
    system: "Name it.",
    user: "A thing.",
    schema: SCHEMA,
    effort: "low",
    maxTokens: 400,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0].apiKey, "test-key");
  assert.deepEqual(sent[0].body, {
    model: "claude-sonnet-5-5",
    max_tokens: 400,
    system: "Name it.",
    messages: [{ role: "user", content: "A thing." }],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "low" },
  });
  assert.deepEqual(reply, {
    text: '{"name":"x"}',
    // The Claude path keeps its accounting: input without the cache, the cache read beside it.
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
    model: "claude-sonnet-5-5",
    stop: "end",
  });
  assert.equal(model.provider, "anthropic");
  assert.equal(model.model, "claude-sonnet-5-5");
});

test("without a schema or an effort there is no output_config", async () => {
  answers.push(message("Hello"));
  await text().complete({ system: "s", user: "u", maxTokens: 10 });
  assert.deepEqual(sent[0].body, {
    model: "claude-sonnet-5-5",
    max_tokens: 10,
    system: "s",
    messages: [{ role: "user", content: "u" }],
  });
});

test("why it stopped is returned, not thrown", async () => {
  answers.push(message("half", "max_tokens"), message("", "refusal"), message("done", "end_turn"));
  const model = text();
  const stops = [];
  for (let i = 0; i < 3; i++) {
    stops.push((await model.complete({ system: "s", user: "u", maxTokens: 10 })).stop);
  }
  assert.deepEqual(stops, ["cut_off", "refused", "end"]);
});

test("a long answer is streamed", async () => {
  answers.push(stream("A long analysis."));
  const reply = await text("claude-opus-5-5").complete({
    system: "s",
    user: "u",
    maxTokens: 64_000,
    effort: "xhigh",
    longOutput: true,
  });
  assert.equal(sent[0].body.stream, true);
  assert.deepEqual(sent[0].body.output_config, { effort: "xhigh" });
  assert.equal(reply.text, "A long analysis.");
  assert.equal(reply.stop, "end");
  assert.deepEqual(reply.usage, { inputTokens: 100, outputTokens: 20, cachedTokens: 30 });
});

test("retries and the time limit are the caller's, else the client's own", async () => {
  answers.push(failure(500), failure(500), message("ok"));
  await text().complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(sent.length, 3);

  sent = [];
  answers.push(failure(500), message("ok"));
  await assert.rejects(text().complete({ system: "s", user: "u", maxTokens: 10, maxRetries: 0 }));
  assert.equal(sent.length, 1);

  sent = [];
  answers.push(message("ok"));
  await text().complete({ system: "s", user: "u", maxTokens: 10, timeoutMs: 60_000 });
  assert.equal(sent[0].timeout, "60");
});

test("each call is one spend line, as the call sites wrote it", async () => {
  answers.push(message("ok"), failure(401));
  const model = text();
  await model.complete({ system: "s", user: "u", maxTokens: 10 });
  await assert.rejects(model.complete({ system: "s", user: "u", maxTokens: 10 }));
  const { duration_ms: _ok, ...ok } = lines[0];
  assert.deepEqual(ok, {
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
  assert.equal(lines[1].outcome, "error");
});

test("a lone surrogate never reaches the API", async () => {
  answers.push(message("ok"));
  await text().complete({ system: "s", user: "cut \ud83d", maxTokens: 10 });
  assert.deepEqual(sent[0].body.messages, [{ role: "user", content: "cut �" }]);
});

test("without a Claude backend there is no model", () => {
  assert.equal(
    anthropicTextModel({ model: "m", feature: "workflow_label", payer: "ratel", config: cfg({}) }),
    null,
  );
  assert.equal(
    anthropicTextModel({
      model: "m",
      feature: "workflow_label",
      payer: "ratel",
      config: cfg({ ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: "k" }),
    }),
    null,
  );
  assert.equal(anthropicProvider.chat, undefined);
});

test("the kit gives a Claude deployment each feature's own model", async () => {
  const label = models.text("workflow_label", { config: cfg(ENV), environment: "production" });
  assert.equal(label?.provider, "anthropic");
  assert.equal(label?.model, "claude-sonnet-5-5");
  const analyst = models.text("match_quality_analyst", {
    config: cfg({ ...ENV, ANTHROPIC_MODEL: "claude-opus-5" }),
    environment: "production",
  });
  assert.equal(analyst?.model, "claude-opus-5");

  answers.push(message("ok"));
  await label?.complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(sent[0].body.model, "claude-sonnet-5-5");
  assert.equal(lines[0].feature, "workflow_label");
});

test("Ratel's own Bedrock setting still goes to the EU profile, signed, with today's body", async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_BACKEND = "bedrock";
  process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  resetConfigForTests();
  try {
    answers.push(failure(503), failure(503), message("ok"));
    const env = { ANTHROPIC_BACKEND: "bedrock", ANTHROPIC_API_KEY: "never-used" };
    const model = models.text("workflow_label", { config: cfg(env), environment: "production" });
    const reply = await model?.complete({
      system: "Name it.",
      user: "A thing.",
      schema: SCHEMA,
      maxTokens: 400,
      // Bedrock retries twice whatever a feature asks for: its errors are the shared capacity.
      maxRetries: 0,
    });
    assert.equal(reply?.text, "ok");
  } finally {
    for (const name of ["ANTHROPIC_BACKEND", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (saved.AWS_SESSION_TOKEN) process.env.AWS_SESSION_TOKEN = saved.AWS_SESSION_TOKEN;
    if (saved.AWS_BEARER_TOKEN_BEDROCK)
      process.env.AWS_BEARER_TOKEN_BEDROCK = saved.AWS_BEARER_TOKEN_BEDROCK;
    resetConfigForTests();
  }
  assert.equal(sent.length, 3);
  assert.equal(
    sent[2].url,
    "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5/invoke",
  );
  assert.equal(sent[2].apiKey, null);
  const { anthropic_version: version, ...body } = sent[2].body;
  assert.equal(typeof version, "string");
  assert.deepEqual(body, {
    max_tokens: 400,
    system: "Name it.",
    messages: [{ role: "user", content: "A thing." }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  assert.equal(lines[0].model, "claude-sonnet-5-5");
  assert.equal(lines[0].backend, "bedrock");
});

test("a model keeps its client: one per time limit and retry count, however many calls", async () => {
  const built: unknown[] = [];
  const model = anthropicTextModel({
    model: "claude-sonnet-5-5",
    feature: "workflow_label",
    payer: "ratel",
    config: cfg(ENV),
    clientFor: (options) => {
      built.push(options);
      return anthropicClient(options, cfg(ENV));
    },
  });
  built.length = 0;
  answers.push(message("a"), message("b"), message("c"));
  await model?.complete({ system: "s", user: "u", maxTokens: 10 });
  await model?.complete({ system: "s", user: "u", maxTokens: 10 });
  await model?.complete({ system: "s", user: "u", maxTokens: 10, maxRetries: 0 });
  assert.deepEqual(built, [{}, { maxRetries: 0 }]);
});
