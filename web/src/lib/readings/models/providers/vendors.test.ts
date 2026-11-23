import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthClient } from "google-auth-library";
import { resolveConfig } from "@/config";
import type { ChatRequest } from "@/lib/contracts/models";
import { setModelCallSink } from "@/lib/platform/model-call";
import { resolveModelVendor } from "../config";
import { models, withProviders } from "../index";
import { resetStructuredOutputs } from "./claude-hosts";
import { vendorAdapters } from "./index";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

/**
 * Each vendor end to end through the kit, from its environment variables to the request on the
 * wire: the address, the key, and what the vendor does its own way.
 */

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const noSleep = async () => {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const completion = (message: Record<string, unknown>) =>
  json({
    model: "served",
    choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });

const response = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  model: "served",
  status: "completed",
  output,
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 9,
  },
  ...extra,
});

const message = (text: string) => ({
  type: "message",
  id: "msg_1",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const claudeMessage = () =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
  });

let logins = 0;
const googleAuth = async () => {
  logins += 1;
  return {
    getAccessToken: async () => ({ token: "google-token" }),
    getRequestHeaders: async () => new Headers({ authorization: "Bearer google-token" }),
  } as unknown as AuthClient;
};

/** Runs `use` with every vendor's adapter on a server that answers in order. */
async function on(answers: Response[], use: () => Promise<void>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push({
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: JSON.parse(await request.text()),
    });
    const next = answers.shift();
    if (!next) throw new Error("the fake server has no answer left");
    return next;
  }) as typeof fetch;
  const restore = withProviders(
    vendorAdapters({
      fetch: fetchImpl,
      sleep: noSleep,
      googleAuth,
      awsKeys: { accessKey: "AKIATEST", secretKey: "secret" },
    }),
  );
  try {
    await use();
  } finally {
    restore();
  }
  return seen;
}

const at = (env: Record<string, string>) => ({ config: cfg(env), environment: "production" });
const ASK = { system: "Be brief.", user: "Say hello.", maxTokens: 400 };
const SCHEMA = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const TOOLS = [
  { name: "crm.lookup", description: "Find a customer", parameters: { properties: { q: {} } } },
];
const LITELLM = {
  MODEL_PROVIDER: "litellm",
  MODEL_BASE_URL: "http://gateway.test",
  MODEL_STANDARD: "gateway-model",
};
const OPENAI = { MODEL_PROVIDER: "openai", OPENAI_API_KEY: "sk-openai" };

/* - OpenAI: the Responses API ----------------------------------------------- */

test("openai: one key, its own address, nothing stored, the tier's model", async () => {
  const seen = await on([json(response([message("Hello")]))], async () => {
    const model = models.text("workflow_label", at(OPENAI));
    assert.deepEqual(await model?.complete(ASK), {
      text: "Hello",
      usage: { inputTokens: 100, outputTokens: 9, cachedTokens: 40 },
      model: "served",
      stop: "end",
    });
  });
  assert.equal(seen[0].url, "https://api.openai.com/v1/responses");
  assert.equal(seen[0].headers.authorization, "Bearer sk-openai");
  assert.deepEqual(seen[0].body, {
    model: "gpt-6.2-sol",
    instructions: "Be brief.",
    input: [{ role: "user", content: "Say hello." }],
    // It thinks within its cap, so a small cap is raised and the thinking kept low.
    max_output_tokens: 4096,
    reasoning: { effort: "low" },
    store: false,
  });
});

test("openai: a schema, an effort and a long streamed answer", async () => {
  const body = response([message('{"name":"x"}')]);
  const stream = [
    { type: "response.created", response: { ...body, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", delta: "…" },
    { type: "response.completed", response: body },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const seen = await on([new Response(stream)], async () => {
    const reply = await models
      .text("match_quality_analyst", at(OPENAI))
      ?.complete({ ...ASK, maxTokens: 64_000, schema: SCHEMA, effort: "xhigh", longOutput: true });
    assert.equal(reply?.text, '{"name":"x"}');
    assert.equal(reply?.usage.inputTokens, 100);
  });
  assert.equal(seen[0].body.model, "gpt-6.2-astra");
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].body.max_output_tokens, 64_000);
  assert.deepEqual(seen[0].body.reasoning, { effort: "xhigh" });
  assert.deepEqual(seen[0].body.text, {
    format: { type: "json_schema", name: "answer", schema: SCHEMA, strict: false },
  });
});

test("openai: a stream that ends early is an error, not a short answer", async () => {
  const cut = `data: ${JSON.stringify({ response: { status: "in_progress", output: [] } })}\n\n`;
  await on([new Response(cut)], async () => {
    await assert.rejects(
      async () => models.text("workflow_label", at(OPENAI))?.complete({ ...ASK, longOutput: true }),
      /cut short/,
    );
  });
});

test("openai: why it stopped", async () => {
  const cases: Array<[unknown, string]> = [
    [
      response([message("half")], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
      "cut_off",
    ],
    [
      response([], { status: "incomplete", incomplete_details: { reason: "content_filter" } }),
      "refused",
    ],
    [response([{ type: "message", content: [{ type: "refusal", refusal: "No." }] }]), "refused"],
  ];
  for (const [body, stop] of cases) {
    await on([json(body)], async () => {
      const reply = await models.text("workflow_label", at(OPENAI))?.complete(ASK);
      assert.equal(reply?.stop, stop);
    });
  }
  await on(
    [json(response([], { status: "failed", error: { code: "server_error" } }))],
    async () => {
      await assert.rejects(
        async () => models.text("workflow_label", at(OPENAI))?.complete(ASK),
        /server_error/,
      );
    },
  );
});

test("openai: a tool call, and the turn it wrote handed back with the result", async () => {
  const written = [
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "crm_lookup",
      arguments: '{"q":"acme"}',
    },
  ];
  const ask: ChatRequest = {
    system: "You help.",
    tools: TOOLS,
    messages: [{ role: "user", text: "Who is Acme?" }],
    maxTokens: 4096,
    effort: "low",
  };
  const seen = await on(
    [json(response(written)), json(response([message("Acme is a customer.")]))],
    async () => {
      const chat = models.chat("eval_gate_replay", at(OPENAI));
      const first = await chat?.next(ask);
      assert.deepEqual(first?.calls, [{ id: "call_1", name: "crm.lookup", args: { q: "acme" } }]);
      const second = await chat?.next({
        ...ask,
        messages: [
          ...ask.messages,
          { role: "assistant", text: "", calls: first?.calls ?? [], raw: first?.raw },
          { role: "tool", callId: "call_1", content: "Acme Inc.", isError: false },
          { role: "tool", callId: "lost", content: "stray", isError: false },
        ],
      });
      assert.equal(second?.text, "Acme is a customer.");
    },
  );
  assert.deepEqual(seen[0].body, {
    model: "gpt-6.2-astra",
    instructions: "You help.",
    input: [{ role: "user", content: "Who is Acme?" }],
    max_output_tokens: 4096,
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"],
    tools: [
      {
        type: "function",
        name: "crm_lookup",
        description: "Find a customer",
        parameters: { type: "object", properties: { q: {} } },
        strict: false,
      },
    ],
    tool_choice: "auto",
    store: false,
  });
  assert.deepEqual(seen[1].body.input, [
    { role: "user", content: "Who is Acme?" },
    ...written,
    { type: "function_call_output", call_id: "call_1", output: "Acme Inc." },
    { role: "user", content: "Tool result: stray" },
  ]);
});

test("openai: a model that does not reason is given neither an effort nor encrypted thinking", async () => {
  const seen = await on([json(response([message("hi")]))], async () => {
    await models
      .chat("eval_gate_replay", { ...at(OPENAI), model: "gpt-4.1" })
      ?.next({ tools: [], messages: [{ role: "user", text: "hi" }], maxTokens: 50, effort: "low" });
  });
  assert.equal(seen[0].body.model, "gpt-4.1");
  assert.equal(seen[0].body.max_output_tokens, 50);
  assert.equal(seen[0].body.reasoning, undefined);
  assert.equal(seen[0].body.include, undefined);
  assert.equal(seen[0].body.temperature, 0);
});

/* - Google Cloud ------------------------------------------------------------ */

const GCP = {
  MODEL_PROVIDER: "gcp",
  GOOGLE_CLOUD_PROJECT: "acme",
  GOOGLE_CLOUD_LOCATION: "eu",
};

test("gcp: Claude by default, on Vertex, with the Google login and no Anthropic key", async () => {
  const seen = await on([claudeMessage()], async () => {
    const model = models.text("workflow_label", at({ ...GCP, ANTHROPIC_API_KEY: "sk-ant" }));
    assert.equal(model?.provider, "anthropic");
    assert.equal((await model?.complete({ ...ASK, schema: SCHEMA }))?.text, "Hello");
  });
  assert.equal(
    seen[0].url,
    "https://aiplatform.eu.rep.googleapis.com/v1/projects/acme/locations/eu/publishers/anthropic/models/claude-sonnet-5-5:rawPredict",
  );
  assert.equal(seen[0].headers.authorization, "Bearer google-token");
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.equal(seen[0].body.model, undefined);
  assert.equal(typeof seen[0].body.anthropic_version, "string");
  assert.deepEqual(seen[0].body.output_config, { format: { type: "json_schema", schema: SCHEMA } });
});

/** Google's answer where an organization does not allow structured outputs on a partner model. */
const disallowed = () =>
  json(
    {
      error: {
        code: 400,
        message:
          "Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures violated for `projects/1` attempting to use a disallowed feature structured_outputs for Partner model claude-sonnet-5-5.",
        status: "FAILED_PRECONDITION",
      },
    },
    400,
  );

test("gcp: where the organization forbids structured outputs, Claude is asked for JSON in words", async () => {
  resetStructuredOutputs();
  const fenced = () =>
    json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: 'Here:\n```json\n{"name":"x"}\n```' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  const seen = await on([disallowed(), fenced(), fenced()], async () => {
    const model = models.text("workflow_label", at(GCP));
    const request = { ...ASK, schema: SCHEMA, effort: "low" as const };
    assert.equal((await model?.complete(request))?.text, '{"name":"x"}');
    // Remembered: the refused form is not tried again.
    assert.equal((await model?.complete(request))?.text, '{"name":"x"}');
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].body.output_config, {
    format: { type: "json_schema", schema: SCHEMA },
    effort: "low",
  });
  for (const sent of seen.slice(1)) {
    assert.deepEqual(sent.body.output_config, { effort: "low" });
    assert.match(String(sent.body.system), /^Be brief\.\n\nAnswer with one JSON object/);
    assert.ok(String(sent.body.system).includes(JSON.stringify(SCHEMA)));
  }
  resetStructuredOutputs();
});

test("gcp: without a schema nothing changes, and any other 400 is the request's own error", async () => {
  resetStructuredOutputs();
  const bad = () => json({ error: { code: 400, message: "prompt is too long" } }, 400);
  const seen = await on([bad(), disallowed()], async () => {
    const model = models.text("workflow_label", at(GCP));
    await assert.rejects(async () => model?.complete({ ...ASK, schema: SCHEMA }), /too long/);
    await assert.rejects(async () => model?.complete(ASK), /structured_outputs/);
  });
  assert.equal(seen.length, 2);
});

test("gcp: a Gemini model by name, on Vertex's chat completions", async () => {
  const seen = await on([completion({ content: "Hello" })], async () => {
    const model = models.text(
      "workflow_label",
      at({ ...GCP, MODEL_STANDARD: "gemini-4-hydrogen", GOOGLE_CLOUD_LOCATION: "global" }),
    );
    assert.equal(model?.provider, "gcp.vertex_ai");
    await model?.complete({ ...ASK, effort: "xhigh" });
  });
  assert.equal(
    seen[0].url,
    "https://aiplatform.googleapis.com/v1/projects/acme/locations/global/endpoints/openapi/chat/completions",
  );
  assert.equal(seen[0].headers.authorization, "Bearer google-token");
  assert.equal(seen[0].body.model, "google/gemini-4-hydrogen");
  assert.equal(seen[0].body.max_tokens, 4096);
  assert.equal(seen[0].body.reasoning_effort, "high");
});

test("gcp: Gemini's thought signature goes back with the call it signed", async () => {
  const written = {
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "crm_lookup", arguments: "{}" },
        extra_content: { google: { thought_signature: "signed" } },
      },
    ],
  };
  const env = { ...GCP, MODEL_DEEP: "gemini-4-carbon" };
  const seen = await on([completion(written), completion({ content: "done" })], async () => {
    const chat = models.chat("eval_gate_replay", at(env));
    const messages = [{ role: "user" as const, text: "go" }];
    const first = await chat?.next({ tools: TOOLS, messages, maxTokens: 100 });
    await chat?.next({
      tools: TOOLS,
      messages: [
        ...messages,
        { role: "assistant", text: "", calls: first?.calls ?? [], raw: first?.raw },
        { role: "tool", callId: "call_1", content: "Acme", isError: false },
      ],
      maxTokens: 100,
    });
  });
  const sent = seen[1].body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(sent[1].tool_calls, written.tool_calls);
});

/* - Amazon Bedrock ---------------------------------------------------------- */

const BEDROCK = { MODEL_PROVIDER: "bedrock", AWS_REGION: "us-east-1" };

test("bedrock: Claude by default, in the region's geography, signed for AWS", async () => {
  const seen = await on([claudeMessage()], async () => {
    const model = models.text("workflow_label", at(BEDROCK));
    assert.equal((await model?.complete(ASK))?.text, "Hello");
  });
  assert.equal(
    seen[0].url,
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5-5/invoke",
  );
  assert.match(
    seen[0].headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d+\/us-east-1\/bedrock\//,
  );
});

test("bedrock: another model by name, signed the same way over the body that is sent", async () => {
  const seen = await on([completion({ content: "Hello" })], async () => {
    const model = models.text(
      "workflow_label",
      at({ ...BEDROCK, MODEL_STANDARD: "openai.gpt-oss-120b-1:0" }),
    );
    assert.equal(model?.provider, "aws.bedrock");
    await model?.complete(ASK);
  });
  assert.equal(
    seen[0].url,
    "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions",
  );
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 .*SignedHeaders=.*host/);
  assert.ok(seen[0].headers["x-amz-date"]);
  assert.equal(seen[0].body.model, "openai.gpt-oss-120b-1:0");
});

test("bedrock: an OpenAI model thinks within its cap, so a small cap is raised", async () => {
  const seen = await on([completion({ content: "Hello" })], async () => {
    await models
      .text("workflow_label", at({ ...BEDROCK, MODEL_STANDARD: "openai.gpt-oss-120b-1:0" }))
      ?.complete(ASK);
  });
  assert.equal(seen[0].body.max_completion_tokens, 4096);
  assert.equal(seen[0].body.max_tokens, undefined);
  assert.equal(seen[0].body.reasoning_effort, "low");
});

test("bedrock: a Bedrock API key signs in place of the AWS login", async () => {
  const env = { ...BEDROCK, AWS_BEARER_TOKEN_BEDROCK: "bedrock-key" };
  const seen = await on([completion({ content: "Hello" })], async () => {
    await models
      .text("workflow_label", at({ ...env, MODEL_STANDARD: "openai.gpt-oss-120b-1:0" }))
      ?.complete(ASK);
  });
  assert.equal(seen[0].headers.authorization, "Bearer bedrock-key");
});

/* - Servers the customer runs ----------------------------------------------- */

test("each self-hosted server is asked at its own address, with a key only when one is set", async () => {
  for (const name of ["ollama", "llama.cpp", "vllm", "litellm", "custom"]) {
    const seen = await on(
      [completion({ content: "Hello" }), completion({ content: "Hello" })],
      async () => {
        const env = {
          MODEL_PROVIDER: name,
          MODEL_BASE_URL: "http://box:9000/v1",
          MODEL_STANDARD: "llama3.3",
          OPENAI_API_KEY: "sk-openai",
        };
        await models.text("workflow_label", at(env))?.complete(ASK);
        await models.text("workflow_label", at({ ...env, MODEL_API_KEY: "own" }))?.complete(ASK);
      },
    );
    assert.equal(seen[0].url, "http://box:9000/v1/chat/completions", name);
    assert.equal(seen[0].headers.authorization, undefined, name);
    assert.equal(seen[1].headers.authorization, "Bearer own", name);
  }
});

/* - For all of them --------------------------------------------------------- */

test("a spend line names the vendor, and where Claude was called", async () => {
  const lines: Record<string, unknown>[] = [];
  const restore = setModelCallSink({
    info: (fields) => void lines.push(fields),
    warn: (fields) => void lines.push(fields),
  });
  try {
    await on(
      [
        json(response([message("a")])),
        completion({ content: "b" }),
        claudeMessage(),
        claudeMessage(),
      ],
      async () => {
        for (const env of [OPENAI, LITELLM, GCP, BEDROCK])
          await models.text("workflow_label", at(env))?.complete(ASK);
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(
    lines.map((line) => [line.provider, line.model, line.backend]),
    [
      ["openai", "gpt-6.2-sol", "api"],
      ["litellm", "gateway-model", "api"],
      ["anthropic", "claude-sonnet-5-5", "vertex"],
      ["anthropic", "claude-sonnet-5-5", "bedrock"],
    ],
  );
});

test("the cloud login is asked for on a call, not when a model is built", async () => {
  logins = 0;
  await on([], async () => {
    models.text("workflow_label", at(GCP));
    models.text("workflow_label", at({ ...GCP, MODEL_STANDARD: "gemini-4-hydrogen" }));
  });
  assert.equal(logins, 0);
});

test("a server that redirects is not followed: the prompt goes to the address that was set", async () => {
  let redirect: unknown;
  const adapters = vendorAdapters({
    fetch: (async (_url: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return completion({ content: "ok" });
    }) as typeof fetch,
  });
  const vendor = resolveModelVendor(
    cfg({ MODEL_PROVIDER: "vllm", MODEL_BASE_URL: "http://box/v1" }),
    "production",
  );
  assert.ok(vendor);
  await adapters.vllm
    .text({ model: "m", feature: "workflow_label", payer: "ratel", vendor, config: cfg({}) })
    ?.complete(ASK);
  assert.equal(redirect, "error");
});
