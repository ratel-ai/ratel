import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { draftModelFromEnv } from "@/lib/views/fix-drafts/model";

const VARIABLES = [
  "ANTHROPIC_BACKEND",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

let saved: (string | undefined)[] = [];
let savedFetch: typeof fetch;
let restoreSink: () => void = () => {};

beforeEach(() => {
  saved = VARIABLES.map((name) => process.env[name]);
  for (const name of VARIABLES) delete process.env[name];
  resetConfigForTests();
  savedFetch = globalThis.fetch;
  restoreSink = setModelCallSink({ info: () => {}, warn: () => {} });
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

/** Answers each status in turn, then a message; counts the requests. */
function stubFetch(statuses: number[]): () => number {
  let count = 0;
  globalThis.fetch = (async () => {
    const status = statuses[count] ?? 200;
    count += 1;
    const body = status === 200 ? message : { message: "busy" };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  }) as typeof fetch;
  return () => count;
}

const input = { system: "s", user: "u", maxTokens: 10 };

test("on Bedrock, a fix draft retries 503 and throttling before it gives up", async () => {
  Object.assign(process.env, {
    ANTHROPIC_BACKEND: "bedrock",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  });
  resetConfigForTests();
  const requests = stubFetch([503, 429]);

  const model = draftModelFromEnv();
  assert.ok(model, "a Claude backend is configured, so there is a draft model");
  const draft = await model.complete(input);

  assert.equal(draft.text, "{}");
  assert.equal(requests(), 3);
});

test("on the Anthropic API, a fix draft still fails at the first 503", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  resetConfigForTests();
  const requests = stubFetch([503]);

  const model = draftModelFromEnv();
  assert.ok(model, "a Claude backend is configured, so there is a draft model");
  await assert.rejects(model.complete(input));
  assert.equal(requests(), 1);
});
