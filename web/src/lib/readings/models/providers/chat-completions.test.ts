import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import type { ModelContext } from "../index";
import { chatCompletions, resetJsonModes } from "./chat-completions";
import { ModelHttpError } from "./http";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

/** One request the fake server saw. */
interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A server that answers the queued responses in order and records what it was sent. */
function server(...responses: Array<Response | Error>) {
  const seen: Seen[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const next = queue.shift();
    if (!next) throw new Error("the fake server has no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(
  message: Record<string, unknown>,
  extra: { finish?: string; usage?: unknown; model?: string } = {},
) {
  return json({
    id: "chatcmpl-1",
    model: extra.model ?? "served-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...message },
        finish_reason: extra.finish ?? "stop",
      },
    ],
    ...(extra.usage === null
      ? {}
      : { usage: extra.usage ?? { prompt_tokens: 12, completion_tokens: 3 } }),
  });
}

function sse(...events: unknown[]): Response {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function context(overrides: Partial<ModelContext> = {}): ModelContext {
  return {
    model: "llama-3.3-70b",
    feature: "workflow_label",
    payer: "ratel",
    vendor: { name: "litellm", baseUrl: "http://llm.test/v1", apiKey: "sk-test" },
    config: cfg({}),
    ...overrides,
  };
}

const noSleep = async () => {};
const SCHEMA = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

function textModel(fetchImpl: typeof fetch, overrides: Partial<ModelContext> = {}) {
  resetJsonModes();
  const model = chatCompletions({ fetch: fetchImpl, sleep: noSleep }).text(context(overrides));
  assert.ok(model);
  return model;
}

function chatModel(fetchImpl: typeof fetch, overrides: Partial<ModelContext> = {}) {
  const model = chatCompletions({ fetch: fetchImpl, sleep: noSleep }).chat?.(
    context({ feature: "eval_gate_replay", ...overrides }),
  );
  assert.ok(model);
  return model;
}

/* - Text ------------------------------------------------------------------- */

test("a plain completion: the request, the answer, the usage", async () => {
  const { seen, fetchImpl } = server(completion({ content: "Hello" }));
  const model = textModel(fetchImpl);
  const reply = await model.complete({ system: "Be brief.", user: "Say hello.", maxTokens: 400 });

  assert.deepEqual(reply, {
    text: "Hello",
    usage: { inputTokens: 12, outputTokens: 3 },
    model: "served-model",
    stop: "end",
  });
  assert.equal(model.provider, "litellm");
  assert.equal(model.model, "llama-3.3-70b");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://llm.test/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, "Bearer sk-test");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.deepEqual(seen[0].body, {
    model: "llama-3.3-70b",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Say hello." },
    ],
    max_tokens: 400,
  });
});

test("a server without a key gets no authorization header", async () => {
  const { seen, fetchImpl } = server(completion({ content: "ok" }));
  const model = textModel(fetchImpl, {
    vendor: { name: "litellm", baseUrl: "http://localhost:8000/v1" },
  });
  await model.complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(seen[0].headers.authorization, undefined);
});

test("a schema is asked for as a non-strict json_schema", async () => {
  const { seen, fetchImpl } = server(completion({ content: '{"name":"x"}' }));
  const reply = await textModel(fetchImpl).complete({
    system: "s",
    user: "u",
    maxTokens: 10,
    schema: SCHEMA,
  });
  assert.deepEqual(JSON.parse(reply.text), { name: "x" });
  assert.deepEqual(seen[0].body.response_format, {
    type: "json_schema",
    json_schema: { name: "answer", schema: SCHEMA, strict: false },
  });
  // The prompt is not touched while the server takes the schema itself.
  assert.deepEqual(seen[0].body.messages, [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ]);
});

test("a server that refuses json_schema is asked for a JSON object, then by prompt alone", async () => {
  const refused = () => json({ error: { message: "response_format is not supported" } }, 400);
  const { seen, fetchImpl } = server(
    refused(),
    refused(),
    completion({ content: '{"name":"x"}' }),
    completion({ content: '{"name":"y"}' }),
  );
  const model = textModel(fetchImpl);
  const request = { system: "s", user: "u", maxTokens: 10, schema: SCHEMA };
  const reply = await model.complete(request);
  assert.deepEqual(JSON.parse(reply.text), { name: "x" });

  assert.equal(seen.length, 3);
  assert.equal((seen[0].body.response_format as { type: string }).type, "json_schema");
  assert.deepEqual(seen[1].body.response_format, { type: "json_object" });
  assert.equal(seen[2].body.response_format, undefined);
  for (const sent of [seen[1], seen[2]]) {
    const system = (sent.body.messages as Array<{ content: string }>)[0].content;
    assert.match(system, /^s\n\nAnswer with one JSON object/);
    assert.ok(system.includes(JSON.stringify(SCHEMA)));
  }

  // What worked is remembered for this server and model: no second walk down the ladder.
  await model.complete(request);
  assert.equal(seen.length, 4);
  assert.equal(seen[3].body.response_format, undefined);
});

test("a server that takes a schema and ignores it is asked again in words, and both calls count", async () => {
  const { seen, fetchImpl } = server(
    completion({ content: "Paris is in France." }),
    completion({ content: '{"landmark":"Eiffel Tower"}' }),
    completion({ content: '{"name":"x"}' }),
    completion({ content: '{"name":"y"}' }),
  );
  const model = textModel(fetchImpl);
  const request = { system: "s", user: "u", maxTokens: 10, schema: SCHEMA };
  const reply = await model.complete(request);
  assert.equal(reply.text, '{"name":"x"}');
  // Three calls of 12 and 3 tokens.
  assert.deepEqual(reply.usage, { inputTokens: 36, outputTokens: 9 });
  assert.equal((seen[0].body.response_format as { type: string }).type, "json_schema");
  assert.deepEqual(seen[1].body.response_format, { type: "json_object" });
  assert.equal(seen[2].body.response_format, undefined);

  // What worked is remembered.
  assert.equal((await model.complete(request)).text, '{"name":"y"}');
  assert.equal(seen.length, 4);
});

test("an answer cut off, refused, or that never fits is handed back as it is", async () => {
  const ask = (...responses: Response[]) => {
    const { seen, fetchImpl } = server(...responses);
    return textModel(fetchImpl)
      .complete({ system: "s", user: "u", maxTokens: 10, schema: SCHEMA })
      .then((reply) => ({ reply, calls: seen.length }));
  };
  const cut = await ask(completion({ content: '{"na' }, { finish: "length" }));
  assert.deepEqual([cut.reply.stop, cut.calls], ["cut_off", 1]);
  const refused = await ask(completion({ content: "" }, { finish: "content_filter" }));
  assert.deepEqual([refused.reply.stop, refused.calls], ["refused", 1]);
  const never = await ask(
    completion({ content: "no" }),
    completion({ content: "no" }),
    completion({ content: "still no" }),
  );
  assert.deepEqual([never.reply.text, never.calls], ["still no", 3]);
});

test("an answer in a code fence or in words is handed back as its JSON; plain JSON as it was written", async () => {
  for (const [content, text] of [
    ['```json\n{"name":"x"}\n```', '{"name":"x"}'],
    // A fence a server's schema support left open.
    ['```json\n{"name":"x"}', '{"name":"x"}'],
    ['Here it is: {"name":"x"}', '{"name":"x"}'],
    ['{ "name": "x" }\n', '{ "name": "x" }\n'],
  ]) {
    const { seen, fetchImpl } = server(completion({ content }));
    const reply = await textModel(fetchImpl).complete({
      system: "s",
      user: "u",
      maxTokens: 10,
      schema: SCHEMA,
    });
    assert.equal(reply.text, text);
    assert.equal(seen.length, 1);
  }
});

test("thinking written into the answer is taken out of it, streamed or not", async () => {
  const cases: Array<[string, string]> = [
    ["<reasoning>Hmm.</reasoning>Paris.", "Paris."],
    ["<think>\nHmm.\n</think>\n\nParis.", "Paris."],
    ["<reasoning>One</reasoning><reasoning> two.</reasoning>Paris.", "Paris."],
    // Only what comes first is thinking; the same words later are the answer's.
    ["Use <think>tags</think>.", "Use <think>tags</think>."],
    // Cut off while it was still thinking: there is no answer.
    ["<think>Hmm", ""],
  ];
  for (const [content, text] of cases) {
    const plain = await textModel(server(completion({ content })).fetchImpl).complete({
      system: "s",
      user: "u",
      maxTokens: 10,
    });
    assert.equal(plain.text, text);
    const chunks = sse({ choices: [{ delta: { content }, finish_reason: "stop" }] });
    const streamed = await textModel(server(chunks).fetchImpl).complete({
      system: "s",
      user: "u",
      maxTokens: 10,
      longOutput: true,
    });
    assert.equal(streamed.text, text);
  }
});

test("a chat turn's thinking is not its text, and goes back with the turn", async () => {
  const content = "<reasoning>Look it up.</reasoning>";
  const { fetchImpl } = server(
    completion({
      content,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "crm_lookup_customer", arguments: "{}" } },
      ],
    }),
  );
  const reply = await chatModel(fetchImpl).next({
    tools: TOOLS,
    messages: [{ role: "user", text: "go" }],
    maxTokens: 100,
  });
  assert.equal(reply.text, "");
  assert.equal(reply.calls.length, 1);
  const raw = reply.raw[0] as { chatCompletions: { content: string } };
  assert.equal(raw.chatCompletions.content, content);
});

test("a 400 without a schema is the request's own error: thrown, not retried", async () => {
  const { seen, fetchImpl } = server(json({ error: { message: "context too long" } }, 400));
  await assert.rejects(
    textModel(fetchImpl).complete({ system: "s", user: "u", maxTokens: 10 }),
    (error: unknown) => error instanceof ModelHttpError && error.status === 400,
  );
  assert.equal(seen.length, 1);
});

test("a 429 and a 5xx are retried, as many times as asked", async () => {
  const busy = () => json({ error: { message: "busy" } }, 503);
  const first = server(busy(), json({}, 429), completion({ content: "ok" }));
  const reply = await textModel(first.fetchImpl).complete({
    system: "s",
    user: "u",
    maxTokens: 10,
  });
  assert.equal(reply.text, "ok");
  assert.equal(first.seen.length, 3);

  const none = server(busy(), completion({ content: "ok" }));
  await assert.rejects(
    textModel(none.fetchImpl).complete({ system: "s", user: "u", maxTokens: 10, maxRetries: 0 }),
    (error: unknown) => error instanceof ModelHttpError && error.status === 503,
  );
  assert.equal(none.seen.length, 1);
});

test("a network failure is retried too", async () => {
  const { seen, fetchImpl } = server(new TypeError("fetch failed"), completion({ content: "ok" }));
  const reply = await textModel(fetchImpl).complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(reply.text, "ok");
  assert.equal(seen.length, 2);
});

test("why it stopped: the length, a filter, a refusal", async () => {
  const cases: Array<[Response, string]> = [
    [completion({ content: "half" }, { finish: "length" }), "cut_off"],
    [completion({ content: "" }, { finish: "content_filter" }), "refused"],
    [completion({ content: null, refusal: "I can't help with that." }), "refused"],
    [completion({ content: "done" }, { finish: "stop" }), "end"],
  ];
  for (const [response, stop] of cases) {
    const reply = await textModel(server(response).fetchImpl).complete({
      system: "s",
      user: "u",
      maxTokens: 10,
    });
    assert.equal(reply.stop, stop);
  }
});

test("cached prompt tokens are a part of input", async () => {
  const { fetchImpl } = server(
    completion(
      { content: "ok" },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    ),
  );
  const reply = await textModel(fetchImpl).complete({ system: "s", user: "u", maxTokens: 10 });
  assert.deepEqual(reply.usage, { inputTokens: 100, outputTokens: 5, cachedTokens: 80 });
});

test("a server that reports no usage gets an estimate, so a budget still moves", async () => {
  const { fetchImpl } = server(completion({ content: "twelve chars" }, { usage: null }));
  const reply = await textModel(fetchImpl).complete({
    system: "four",
    user: "four",
    maxTokens: 10,
  });
  assert.deepEqual(reply.usage, { inputTokens: 2, outputTokens: 3 });
});

test("a long answer is streamed, with its usage", async () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    model: "served-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const { seen, fetchImpl } = server(
    sse(
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      { model: "served-model", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ),
  );
  const reply = await textModel(fetchImpl).complete({
    system: "s",
    user: "u",
    maxTokens: 64_000,
    longOutput: true,
  });
  assert.deepEqual(reply, {
    text: "Hello",
    usage: { inputTokens: 7, outputTokens: 2 },
    model: "served-model",
    stop: "end",
  });
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual(seen[0].body.stream_options, { include_usage: true });
});

test("a stream dropped before it said why it stopped is an error, not half an answer", async () => {
  const chunk = (delta: unknown) => ({
    model: "served-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const { fetchImpl } = server(
    sse(chunk({ role: "assistant", content: "" }), chunk({ content: '{"proposals": [' })),
  );
  await assert.rejects(
    textModel(fetchImpl).complete({ system: "s", user: "u", maxTokens: 64_000, longOutput: true }),
    /stream was cut short/,
  );
});

test("effort is dropped unless the model is named as a reasoning model", async () => {
  const plain = server(completion({ content: "ok" }));
  await textModel(plain.fetchImpl).complete({
    system: "s",
    user: "u",
    maxTokens: 10,
    effort: "xhigh",
  });
  assert.equal(plain.seen[0].body.reasoning_effort, undefined);
  assert.equal(plain.seen[0].body.max_tokens, 10);

  const reasoning = server(completion({ content: "ok" }), completion({ content: "ok" }));
  const model = textModel(reasoning.fetchImpl, {
    model: "gpt-5.5",
    config: cfg({ MODEL_REASONING_MODELS: "o4, gpt-5" }),
  });
  await model.complete({ system: "s", user: "u", maxTokens: 10, effort: "xhigh" });
  await model.complete({ system: "s", user: "u", maxTokens: 10, effort: "low" });
  // A reasoning model takes `max_completion_tokens`, and `xhigh` is its `high`.
  assert.equal(reasoning.seen[0].body.reasoning_effort, "high");
  assert.equal(reasoning.seen[0].body.max_completion_tokens, 4096);
  assert.equal(reasoning.seen[0].body.max_tokens, undefined);
  assert.equal(reasoning.seen[1].body.reasoning_effort, "low");
});

test("a lone surrogate never reaches the server", async () => {
  const { seen, fetchImpl } = server(completion({ content: "ok" }));
  await textModel(fetchImpl).complete({ system: "s", user: "cut \ud83d", maxTokens: 10 });
  const sent = (seen[0].body.messages as Array<{ content: string }>)[1].content;
  assert.equal(sent, "cut �");
});

test("each call is one spend line, with the feature and the tokens", async () => {
  const lines: Record<string, unknown>[] = [];
  const restore = setModelCallSink({
    info: (fields) => void lines.push(fields),
    warn: (fields) => void lines.push(fields),
  });
  try {
    const { fetchImpl } = server(
      completion({ content: "ok" }),
      json({ error: { message: "no" } }, 401),
    );
    const model = textModel(fetchImpl, { payer: "customer" });
    await model.complete({ system: "s", user: "u", maxTokens: 10 });
    await assert.rejects(model.complete({ system: "s", user: "u", maxTokens: 10 }));
  } finally {
    restore();
  }
  assert.equal(lines.length, 2);
  const { duration_ms: _first, ...ok } = lines[0];
  assert.deepEqual(ok, {
    provider: "litellm",
    model: "llama-3.3-70b",
    feature: "workflow_label",
    payer: "customer",
    organization_id: null,
    project_id: null,
    input_tokens: 12,
    output_tokens: 3,
    outcome: "ok",
    backend: "api",
  });
  assert.equal(lines[1].outcome, "error");
  assert.equal(lines[1].error_type, "ModelHttpError");
});

/* - Chat with tools -------------------------------------------------------- */

const TOOLS = [
  {
    name: "crm.lookup customer",
    description: "Find a customer",
    parameters: { properties: { q: { type: "string" } } },
  },
];

test("a tool call: what is sent, and what comes back", async () => {
  const assistant = {
    content: null,
    tool_calls: [
      {
        id: "call_abc",
        type: "function",
        function: { name: "crm_lookup_customer", arguments: '{"q":"acme"}' },
      },
    ],
  };
  const { seen, fetchImpl } = server(completion(assistant, { finish: "tool_calls" }));
  const reply = await chatModel(fetchImpl).next({
    system: "You are a support agent.",
    tools: TOOLS,
    messages: [{ role: "user", text: "Who is Acme?" }],
    maxTokens: 4096,
  });

  assert.deepEqual(seen[0].body, {
    model: "llama-3.3-70b",
    messages: [
      { role: "system", content: "You are a support agent." },
      { role: "user", content: "Who is Acme?" },
    ],
    max_tokens: 4096,
    temperature: 0,
    tools: [
      {
        type: "function",
        function: {
          // A name the API would refuse is sent in a safe form and mapped back on the answer.
          name: "crm_lookup_customer",
          description: "Find a customer",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ],
    tool_choice: "auto",
  });
  assert.equal(reply.text, "");
  assert.deepEqual(reply.calls, [
    { id: "call_abc", name: "crm.lookup customer", args: { q: "acme" } },
  ]);
  assert.equal(reply.stop, "end");
  assert.deepEqual(reply.raw, [{ chatCompletions: { role: "assistant", ...assistant } }]);
});

test("the turn it wrote goes back unchanged, with the tool's result after it", async () => {
  const written = {
    role: "assistant",
    content: null,
    reasoning_content: "The user wants Acme.",
    tool_calls: [
      {
        id: "call_abc",
        type: "function",
        function: { name: "crm_lookup_customer", arguments: "{}" },
      },
    ],
  };
  const { seen, fetchImpl } = server(completion({ content: "Acme is a customer." }));
  const reply = await chatModel(fetchImpl).next({
    tools: TOOLS,
    messages: [
      { role: "user", text: "Who is Acme?" },
      {
        role: "assistant",
        text: "",
        calls: [{ id: "call_abc", name: "crm.lookup customer", args: {} }],
        raw: [{ chatCompletions: written }],
      },
      { role: "tool", callId: "call_abc", content: "Acme Inc.", isError: false },
      { role: "tool", callId: "call_def", content: "timeout", isError: true },
    ],
    maxTokens: 100,
  });
  assert.deepEqual(seen[0].body.messages, [
    { role: "user", content: "Who is Acme?" },
    written,
    { role: "tool", tool_call_id: "call_abc", content: "Acme Inc." },
    // A result whose call is not in the conversation is refused as one, so it is told as text.
    { role: "user", content: "Tool result: timeout" },
  ]);
  assert.equal(reply.text, "Acme is a customer.");
  assert.deepEqual(reply.calls, []);
});

test("a turn another provider wrote is rebuilt from its text and calls", async () => {
  const { seen, fetchImpl } = server(completion({ content: "ok" }));
  await chatModel(fetchImpl).next({
    tools: TOOLS,
    messages: [
      { role: "user", text: "one" },
      { role: "user", text: "two" },
      {
        role: "assistant",
        text: "Looking.",
        calls: [{ id: "toolu_1", name: "crm.lookup customer", args: { q: "acme" } }],
        raw: [{ type: "thinking", thinking: "…", signature: "sig" }],
      },
      { role: "tool", callId: "toolu_1", content: "Acme Inc.", isError: false },
    ],
    maxTokens: 100,
  });
  assert.deepEqual(seen[0].body.messages, [
    // Two asks in a row are one turn: many chat templates need the roles to alternate.
    { role: "user", content: "one\n\ntwo" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "crm_lookup_customer", arguments: '{"q":"acme"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "Acme Inc." },
  ]);
});

test("arguments that are not JSON become no arguments; missing ids get one", async () => {
  const { fetchImpl } = server(
    completion({
      content: "Calling.",
      tool_calls: [
        {
          id: "",
          type: "function",
          function: { name: "crm_lookup_customer", arguments: "{q: acme" },
        },
        { id: "", type: "function", function: { name: "crm_lookup_customer", arguments: '["x"]' } },
      ],
    }),
  );
  const reply = await chatModel(fetchImpl).next({
    tools: TOOLS,
    messages: [{ role: "user", text: "go" }],
    maxTokens: 100,
  });
  assert.deepEqual(reply.calls, [
    { id: "call_1", name: "crm.lookup customer", args: {} },
    { id: "call_2", name: "crm.lookup customer", args: {} },
  ]);
  // The turn that goes back carries the same ids the calls were given.
  const raw = reply.raw[0] as { chatCompletions: { tool_calls: Array<{ id: string }> } };
  assert.deepEqual(
    raw.chatCompletions.tool_calls.map((call) => call.id),
    ["call_1", "call_2"],
  );
});

test("without tools none are offered", async () => {
  const { seen, fetchImpl } = server(completion({ content: "hi" }));
  await chatModel(fetchImpl).next({
    tools: [],
    messages: [{ role: "user", text: "hi" }],
    maxTokens: 10,
  });
  assert.equal(seen[0].body.tools, undefined);
  assert.equal(seen[0].body.tool_choice, undefined);
});

test("a reasoning model is not given a temperature", async () => {
  const { seen, fetchImpl } = server(completion({ content: "hi" }));
  await chatModel(fetchImpl, {
    model: "o4-mini",
    config: cfg({ MODEL_REASONING_MODELS: "o4" }),
  }).next({
    tools: [],
    messages: [{ role: "user", text: "hi" }],
    maxTokens: 10,
    effort: "low",
  });
  assert.equal(seen[0].body.temperature, undefined);
  assert.equal(seen[0].body.reasoning_effort, "low");
  assert.equal(seen[0].body.max_completion_tokens, 4096);
});
