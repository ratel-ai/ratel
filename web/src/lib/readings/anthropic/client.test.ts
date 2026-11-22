import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { resolveConfig } from "@/config";
import { setModelCallExceptionReporter } from "@/lib/platform/model-call";
import { anthropicAgent, ModelNotEnabled, ModelRefused } from "@/lib/views/eval-gate/models";
import {
  anthropicBackend,
  anthropicClient,
  anthropicConfigured,
  ModelNotEnabledError,
} from "./client";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string>) => resolveConfig({ env });

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

type Seen = { url: string; body: Record<string, unknown>; headers: Headers };

/** A fake network that records each request and answers one message. */
function fakeFetch(status = 200): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return new Response(
      status === 200 ? JSON.stringify(message) : JSON.stringify({ message: "no" }),
      {
        status,
        // retry-after-ms keeps the SDK's backoff short when Bedrock retries.
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

/** A fake network that answers each status in turn, then a message. */
function flakyFetch(statuses: number[]): { fetch: typeof fetch; calls: () => number } {
  let count = 0;
  const fetchImpl = (async () => {
    const status = statuses[count] ?? 200;
    count += 1;
    const body = status === 200 ? message : { message: "busy" };
    // retry-after-ms keeps the SDK's backoff short in tests.
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => count };
}

const AWS_VARIABLES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;
const savedAws = AWS_VARIABLES.map((name) => process.env[name]);

before(() => {
  for (const name of AWS_VARIABLES) process.env[name] = "test";
});

after(() => {
  AWS_VARIABLES.forEach((name, index) => {
    if (savedAws[index] === undefined) delete process.env[name];
    else process.env[name] = savedAws[index];
  });
});

const params = { max_tokens: 10, messages: [{ role: "user" as const, content: "hi" }] };

test("without a backend, a key selects the Anthropic API", async () => {
  const { fetch, seen } = fakeFetch();
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_API_KEY: "sk-test" }));

  await client!.messages.create({ ...params, model: "claude-sonnet-5-5" });

  assert.equal(new URL(seen[0]!.url).hostname, "api.anthropic.com");
  assert.equal(seen[0]!.body.model, "claude-sonnet-5-5");
});

test("without a backend, a missing or placeholder key gives no client", () => {
  assert.equal(anthropicClient({}, cfg({})), null);
  assert.equal(anthropicClient({}, cfg({ ANTHROPIC_API_KEY: "REPLACE_ME" })), null);
  assert.equal(anthropicConfigured(cfg({})), false);
  assert.equal(anthropicConfigured(cfg({ ANTHROPIC_API_KEY: "REPLACE_ME" })), false);
  assert.equal(anthropicConfigured(cfg({ ANTHROPIC_API_KEY: "sk-test" })), true);
});

test("on Bedrock, a call goes to the EU profile in Frankfurt and never uses the API key", async () => {
  const { fetch, seen } = fakeFetch();
  const client = anthropicClient(
    { fetch, maxRetries: 0 },
    cfg({ ANTHROPIC_BACKEND: "bedrock", ANTHROPIC_API_KEY: "sk-must-not-leak" }),
  );

  const reply = await client!.messages.create({ ...params, model: "claude-sonnet-5-5" });

  const url = new URL(seen[0]!.url);
  assert.equal(url.hostname, "bedrock-runtime.eu-central-1.amazonaws.com");
  assert.equal(decodeURIComponent(url.pathname), "/model/eu.anthropic.claude-sonnet-5-5/invoke");
  assert.equal(seen[0]!.headers.get("x-api-key"), null);
  assert.match(seen[0]!.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.equal(reply.stop_reason, "end_turn");
});

test("on Bedrock, the deployment is configured without any API key", () => {
  assert.equal(anthropicConfigured(cfg({ ANTHROPIC_BACKEND: "bedrock" })), true);
});

test("on Bedrock, a dated snapshot of a model reaches that model's EU profile", async () => {
  const { fetch, seen } = fakeFetch();
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

  await client!.messages.create({ ...params, model: "claude-haiku-4-5-20251001" });

  assert.equal(
    decodeURIComponent(new URL(seen[0]!.url).pathname),
    "/model/eu.anthropic.claude-haiku-4-5-20251001-v1:0/invoke",
  );
});

test("on Bedrock, a model with no EU profile fails as not found, with no request", async () => {
  const { fetch, seen } = fakeFetch();
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

  await assert.rejects(
    client!.messages.create({ ...params, model: "claude-fable-5-1" }),
    Anthropic.NotFoundError,
  );
  assert.equal(seen.length, 0);
});

test("a Bedrock refusal is the same error class the call sites catch", async () => {
  const { fetch } = fakeFetch(403);
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

  await assert.rejects(
    client!.messages.create({ ...params, model: "claude-sonnet-5-5" }),
    Anthropic.PermissionDeniedError,
  );
});

/** Bedrock's answer for a model whose AWS Marketplace agreement was never accepted (staging, 2026-11-12). */
const MARKETPLACE_DENIED =
  "Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions " +
  "(aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access to this model.";

/** A fake network that answers every request with one status and message. */
function deniedFetch(status: number, text: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ message: text }), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    })) as typeof fetch;
}

test("on Bedrock, a 403 for a missing Marketplace agreement is ModelNotEnabledError with the model and its EU profile", async () => {
  const client = anthropicClient(
    { fetch: deniedFetch(403, MARKETPLACE_DENIED), maxRetries: 0 },
    cfg({ ANTHROPIC_BACKEND: "bedrock" }),
  );

  const err = await client!.messages
    .create({ ...params, model: "claude-sonnet-4-6" })
    .catch((e: unknown) => e);

  assert.ok(err instanceof ModelNotEnabledError);
  assert.ok(
    err instanceof Anthropic.PermissionDeniedError,
    "call sites that catch a refusal still catch it",
  );
  assert.equal(err.model, "claude-sonnet-4-6");
  assert.equal(err.bedrockProfile, "eu.anthropic.claude-sonnet-4-6");
  assert.equal(err.errorType, "model_not_enabled");
});

test("on Bedrock, a replay agent on a model not enabled stops with ModelNotEnabled, which is a refusal too", async () => {
  const client = anthropicClient(
    { fetch: deniedFetch(403, MARKETPLACE_DENIED), maxRetries: 0 },
    cfg({ ANTHROPIC_BACKEND: "bedrock" }),
  );
  const restoreReporter = setModelCallExceptionReporter(() => {});
  try {
    const agent = anthropicAgent(client!, "claude-sonnet-4-6", "claude-opus-5-5");

    const err = await agent
      .next({ system: undefined, tools: [], messages: [{ role: "user", text: "hi" }] })
      .catch((e: unknown) => e);

    assert.ok(err instanceof ModelNotEnabled);
    assert.ok(err instanceof ModelRefused);
    assert.equal(err.model, "claude-sonnet-4-6");
    assert.equal(err.bedrockProfile, "eu.anthropic.claude-sonnet-4-6");
  } finally {
    restoreReporter();
  }
});

test("on Bedrock, another 403 stays a plain refusal", async () => {
  const client = anthropicClient(
    {
      fetch: deniedFetch(403, "User is not authorized to perform: bedrock:InvokeModel"),
      maxRetries: 0,
    },
    cfg({ ANTHROPIC_BACKEND: "bedrock" }),
  );

  const err = await client!.messages
    .create({ ...params, model: "claude-sonnet-5-5" })
    .catch((e: unknown) => e);

  assert.ok(err instanceof Anthropic.PermissionDeniedError);
  assert.ok(!(err instanceof ModelNotEnabledError));
});

test("on Bedrock, a throttle that names Marketplace stays a rate limit", async () => {
  const client = anthropicClient(
    { fetch: deniedFetch(429, MARKETPLACE_DENIED), maxRetries: 0 },
    cfg({ ANTHROPIC_BACKEND: "bedrock" }),
  );

  const err = await client!.messages
    .create({ ...params, model: "claude-sonnet-5-5" })
    .catch((e: unknown) => e);

  assert.ok(err instanceof Anthropic.RateLimitError);
  assert.ok(!(err instanceof ModelNotEnabledError));
});

test("on the Anthropic API, a 403 with the same words stays a plain refusal", async () => {
  const client = anthropicClient(
    { fetch: deniedFetch(403, MARKETPLACE_DENIED), maxRetries: 0 },
    cfg({ ANTHROPIC_API_KEY: "sk-test" }),
  );

  const err = await client!.messages
    .create({ ...params, model: "claude-sonnet-4-6" })
    .catch((e: unknown) => e);

  assert.ok(err instanceof Anthropic.PermissionDeniedError);
  assert.ok(!(err instanceof ModelNotEnabledError));
});

test("on Bedrock, a streamed message reaches the EU profile", async () => {
  const { fetch, seen } = fakeFetch(500);
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

  await assert.rejects(
    client!.messages.stream({ ...params, model: "claude-opus-5-5" }).finalMessage(),
  );

  assert.equal(
    decodeURIComponent(new URL(seen[0]!.url).pathname),
    "/model/eu.anthropic.claude-opus-5-5/invoke-with-response-stream",
  );
});

test("on Bedrock, a replay recorded on a model with no EU profile continues on the EU fallback", async () => {
  const { fetch, seen } = fakeFetch();
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));
  const agent = anthropicAgent(client!, "claude-fable-5-1", "claude-opus-5-5");

  await agent.next({ system: undefined, tools: [], messages: [{ role: "user", text: "hi" }] });

  assert.equal(seen.length, 1);
  assert.equal(
    decodeURIComponent(new URL(seen[0]!.url).pathname),
    "/model/eu.anthropic.claude-opus-5-5/invoke",
  );
});

test("on Bedrock, a base URL in the environment cannot move the host out of Frankfurt", async () => {
  const saved = process.env.ANTHROPIC_BEDROCK_BASE_URL;
  process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://outside-eu.example.invalid";
  try {
    const { fetch, seen } = fakeFetch();
    const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

    await client!.messages.create({ ...params, model: "claude-sonnet-5-5" });

    assert.equal(new URL(seen[0]!.url).hostname, "bedrock-runtime.eu-central-1.amazonaws.com");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    else process.env.ANTHROPIC_BEDROCK_BASE_URL = saved;
  }
});

test("on Bedrock, a bearer token gives no client, because it would replace the task role", () => {
  const env = cfg({ ANTHROPIC_BACKEND: "bedrock" });
  const saved = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "token";
  try {
    assert.equal(anthropicClient({}, env), null);
    assert.equal(anthropicConfigured(env), false);
  } finally {
    if (saved === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = saved;
  }
});

test("an unknown backend gives no client, even with a key, and no call can leave", () => {
  const env = cfg({ ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(anthropicClient({}, env), null);
  assert.equal(anthropicConfigured(env), false);
});

test("the active backend is bedrock only when ANTHROPIC_BACKEND says so, else api", () => {
  assert.equal(anthropicBackend(cfg({ ANTHROPIC_BACKEND: "bedrock" })), "bedrock");
  assert.equal(anthropicBackend(cfg({ ANTHROPIC_BACKEND: " bedrock " })), "bedrock");
  assert.equal(anthropicBackend(cfg({ ANTHROPIC_API_KEY: "sk-test" })), "api");
  assert.equal(anthropicBackend(cfg({})), "api");
  assert.equal(anthropicBackend(cfg({ ANTHROPIC_BACKEND: "REPLACE_ME" })), "api");
});

for (const [name, status] of [
  ["503 Service Unavailable", 503],
  ["throttling (429)", 429],
] as const) {
  test(`on Bedrock, ${name} is retried at least twice, even when the caller asks for no retries`, async () => {
    const { fetch, calls } = flakyFetch([status, status]);
    const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

    const reply = await client!.messages.create({ ...params, model: "claude-sonnet-5-5" });

    assert.equal(reply.stop_reason, "end_turn");
    assert.equal(calls(), 3);
  });
}

test("on Bedrock, a caller asking for more retries keeps them", async () => {
  const { fetch, calls } = flakyFetch([503, 503, 503]);
  const client = anthropicClient({ fetch, maxRetries: 3 }, cfg({ ANTHROPIC_BACKEND: "bedrock" }));

  await client!.messages.create({ ...params, model: "claude-sonnet-5-5" });

  assert.equal(calls(), 4);
});

test("on the Anthropic API, the caller's retry setting is kept as is", async () => {
  const { fetch, calls } = flakyFetch([503]);
  const client = anthropicClient({ fetch, maxRetries: 0 }, cfg({ ANTHROPIC_API_KEY: "sk-test" }));

  await assert.rejects(
    client!.messages.create({ ...params, model: "claude-sonnet-5-5" }),
    Anthropic.InternalServerError,
  );
  assert.equal(calls(), 1);
});
