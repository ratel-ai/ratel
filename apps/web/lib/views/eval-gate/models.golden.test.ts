/**
 * Golden test: pins the request each eval-gate model sends today, so the
 * provider-neutral model kit (ADR-0033) can be proven identical on the Claude
 * path. A diff here means the wire request changed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setModelCallSink } from "@/lib/platform/model-call";
import {
  AGENT_MAX_TOKENS,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_REPLAY_MODEL,
  ModelRefused,
  type ReplayMessage,
  resolveEvalModels,
  resolveTaskJudge,
  resolveTestDraftModel,
  SMALL_MAX_TOKENS,
  TEST_DRAFT_PROMPT,
} from "./models";
import type { ToolDef } from "./types";

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
    model: "claude-haiku-5-5",
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

/** One answer with these content blocks. */
const blocks = (content: unknown[], stopReason = "end_turn") =>
  Response.json({
    id: "msg_golden",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: USAGE,
  });

const apiError = (status: number, type: string) => () =>
  new Response(JSON.stringify({ type: "error", error: { type, message: "no" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A name the API refuses and a schema with no type, beside a plain tool. */
const TOOLS: ToolDef[] = [
  { name: "crm.lookup user", description: "Find a user by email.", parameters: {} },
  {
    name: "send_email",
    description: "Send an email.",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
      required: ["to"],
    },
  },
];

const API_TOOLS = [
  {
    name: "crm_lookup_user",
    description: "Find a user by email.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_email",
    description: "Send an email.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
      required: ["to"],
    },
  },
];

/** A turn with a tool call whose id the API refuses, its failed result, a second call, and a result with no call. */
const MESSAGES: ReplayMessage[] = [
  { role: "user", text: "Email Ada her invoice." },
  {
    role: "assistant",
    text: "Looking her up.",
    calls: [{ id: "call 1!", name: "crm.lookup user", args: { email: "ada@example.com" } }],
  },
  { role: "tool", callId: "call 1!", content: '{"error":"not found"}', isError: true },
  {
    role: "assistant",
    text: "",
    calls: [{ id: "toolu_2", name: "send_email", args: { to: "ada@example.com" } }],
  },
  { role: "tool", callId: "toolu_2", content: '{"sent":true}', isError: false },
  { role: "tool", callId: "never-called", content: "stray", isError: false },
  { role: "user", text: "Thanks." },
];

const API_MESSAGES = [
  { role: "user", content: [{ type: "text", text: "Email Ada her invoice." }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking her up." },
      {
        type: "tool_use",
        id: "call_0",
        name: "crm_lookup_user",
        input: { email: "ada@example.com" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call_0",
        content: '{"error":"not found"}',
        is_error: true,
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "toolu_2", name: "send_email", input: { to: "ada@example.com" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: '{"sent":true}' },
      { type: "text", text: "Tool result: stray" },
      { type: "text", text: "Thanks." },
    ],
  },
];

const JUDGE_SYSTEM =
  "You check one run of an AI agent against a reviewer's criteria. Read only the run as described: the tools it called in order, " +
  "which failed, and how it ended. Answer pass only when the run meets every criterion; when the description can't show a criterion, it fails.";

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean", description: "true only when the run meets every criterion" },
  },
  required: ["pass"],
  additionalProperties: false,
};

const STAND_IN_SYSTEM =
  "You stand in for one tool of an AI agent while a past run is replayed in a test. Reply with only what the tool would return for this call: " +
  "the same shape and style as its recorded results when there are any, else plausible JSON. No commentary.";

const PERSON_SYSTEM =
  "You play the person talking to an AI agent in a test. Follow the description of the person. Reply with only the person's next message " +
  "to the agent, in their words: one short message, no commentary, no quotes.";

function agentOf(recordedModel: string | null, env: Record<string, string | undefined> = ENV) {
  const models = resolveEvalModels(env, "eval_gate_judge", "production");
  assert.equal(models.standIn, false);
  const agent = models.agent?.({ recordedModel, recorded: [] });
  assert.ok(agent);
  return agent;
}

test("the defaults: opus for the replay, haiku for the small calls, 4096 and 1024 tokens", () => {
  assert.equal(DEFAULT_REPLAY_MODEL, "claude-opus-5-5");
  assert.equal(DEFAULT_JUDGE_MODEL, "claude-haiku-5-5");
  assert.equal(AGENT_MAX_TOKENS, 4096);
  assert.equal(SMALL_MAX_TOKENS, 1024);
});

test("the agent's next action: tools with safe names, the conversation as API turns, low effort, no temperature", async () => {
  stubFetch([
    () =>
      blocks(
        [
          { type: "text", text: "Sending." },
          { type: "tool_use", id: "toolu_9", name: "crm_lookup_user", input: { email: "a@b.c" } },
        ],
        "tool_use",
      ),
  ]);
  const agent = agentOf(null);
  assert.equal(agent.model, "claude-opus-5-5");

  const reply = await agent.next({ system: "AGENT SYSTEM", tools: TOOLS, messages: MESSAGES });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      system: "AGENT SYSTEM",
      tools: API_TOOLS,
      tool_choice: { type: "auto" },
      messages: API_MESSAGES,
      output_config: { effort: "low" },
    }),
  ]);
  // The call comes back under the tool's own name, with the answer's blocks kept as `raw`.
  const { latencyMs, ...rest } = reply;
  assert.equal(typeof latencyMs, "number");
  assert.deepStrictEqual(rest, {
    text: "Sending.",
    calls: [{ id: "toolu_9", name: "crm.lookup user", args: { email: "a@b.c" } }],
    raw: [
      { type: "text", text: "Sending." },
      { type: "tool_use", id: "toolu_9", name: "crm_lookup_user", input: { email: "a@b.c" } },
    ],
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
    model: "claude-opus-5-5",
  });
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(lineOf(0), okLine("claude-opus-5-5", "eval_gate_replay"));
});

test("the agent with no system, no tools: an empty tools list is still sent, and `raw` blocks go back unchanged", async () => {
  stubFetch([() => blocks([{ type: "text", text: "Done." }])]);
  const raw = [
    { type: "thinking", thinking: "hm", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "send_email", input: { to: "x" } },
  ];
  const agent = agentOf(null);

  await agent.next({
    system: undefined,
    tools: [],
    messages: [
      { role: "assistant", text: "dropped: the API starts with a user turn", calls: [] },
      { role: "user", text: "Go." },
      {
        role: "assistant",
        text: "ignored when raw is kept",
        calls: [{ id: "toolu_1", name: "send_email", args: { to: "x" } }],
        raw,
      },
      { role: "tool", callId: "toolu_1", content: "ok", isError: false },
    ],
  });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      tools: [],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: [{ type: "text", text: "Go." }] },
        { role: "assistant", content: raw },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
      output_config: { effort: "low" },
    }),
  ]);
});

test("a recorded 4.x Claude model replays as itself at temperature 0 with no effort", async () => {
  stubFetch([() => blocks([{ type: "text", text: "Done." }])]);
  const agent = agentOf("claude-haiku-4-5");
  assert.equal(agent.model, "claude-haiku-4-5");

  await agent.next({ system: "S", tools: [], messages: [{ role: "user", text: "Go." }] });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: "S",
      tools: [],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [{ type: "text", text: "Go." }] }],
      temperature: 0,
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-4-5", "eval_gate_replay"));
});

test("a recorded model that is not Claude replays on EVAL_GATE_REPLAY_MODEL, under the feature given", async () => {
  stubFetch([() => blocks([{ type: "text", text: "Done." }])]);
  const models = resolveEvalModels(
    { ...ENV, EVAL_GATE_REPLAY_MODEL: "claude-sonnet-5-5" },
    "eval_gate_judge",
    "production",
    "eval_gate_what_if",
  );
  const agent = models.agent?.({ recordedModel: "gpt-6", recorded: [] });
  assert.ok(agent);

  await agent.next({ system: "S", tools: [], messages: [{ role: "user", text: "Go." }] });

  assert.equal((sent[0]!.body as { model: string }).model, "claude-sonnet-5-5");
  assert.deepStrictEqual(lineOf(0), okLine("claude-sonnet-5-5", "eval_gate_what_if"));
});

test("EVAL_GATE_REPLAY_MODEL_OVERRIDE replays every run on that model locally, and is ignored in production", async () => {
  stubFetch([() => blocks([{ type: "text", text: "Done." }])]);
  const env = { ...ENV, EVAL_GATE_REPLAY_MODEL_OVERRIDE: "claude-haiku-5-5" };
  const input = { system: "S", tools: [], messages: [{ role: "user" as const, text: "Go." }] };

  const local = resolveEvalModels(env, "eval_gate_judge", "development");
  await local.agent?.({ recordedModel: "claude-opus-5-5", recorded: [] })?.next(input);
  const production = resolveEvalModels(env, "eval_gate_judge", "production");
  await production.agent?.({ recordedModel: "claude-opus-5-5", recorded: [] })?.next(input);

  assert.deepStrictEqual(
    sent.map((call) => (call.body as { model: string }).model),
    ["claude-haiku-5-5", "claude-opus-5-5"],
  );
});

test("a model the API no longer serves: one 404, then the same request on the fallback, each on its own line", async () => {
  stubFetch([apiError(404, "not_found_error"), () => blocks([{ type: "text", text: "Done." }])]);
  const agent = agentOf("claude-opus-4-1");

  const reply = await agent.next({
    system: "S",
    tools: [],
    messages: [{ role: "user", text: "Go." }],
  });

  assert.equal(reply.model, "claude-opus-5-5");
  const shared = {
    max_tokens: 4096,
    system: "S",
    tools: [],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: [{ type: "text", text: "Go." }] }],
  };
  assert.deepStrictEqual(sent, [
    request({ ...shared, model: "claude-opus-4-1", temperature: 0 }),
    request({ ...shared, model: "claude-opus-5-5", output_config: { effort: "low" } }),
  ]);
  assert.deepStrictEqual(
    [lineOf(0), lineOf(1)],
    [
      errorLine("claude-opus-4-1", "eval_gate_replay", "NotFoundError"),
      okLine("claude-opus-5-5", "eval_gate_replay"),
    ],
  );
});

test("a refused key is one request, ModelRefused, and an error line", async () => {
  stubFetch([apiError(401, "authentication_error")]);
  const agent = agentOf(null);

  await assert.rejects(
    agent.next({ system: "S", tools: [], messages: [{ role: "user", text: "Go." }] }),
    ModelRefused,
  );

  assert.equal(sent.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-opus-5-5", "eval_gate_replay", "AuthenticationError"),
  );
});

test("a server error is tried three times (the SDK's two retries) and recorded once as an error", async () => {
  stubFetch([serverError]);
  const agent = agentOf(null);

  await assert.rejects(
    agent.next({ system: "S", tools: [], messages: [{ role: "user", text: "Go." }] }),
  );

  assert.equal(sent.length, 3);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(
    lineOf(0),
    errorLine("claude-opus-5-5", "eval_gate_replay", "InternalServerError"),
  );
});

test("the judge: the small model, the pass schema, low effort", async () => {
  stubFetch([() => message('{"pass":true}')]);
  const { judge } = resolveEvalModels(ENV, "eval_gate_judge", "production");
  assert.ok(judge);
  assert.equal(judge.model, "claude-haiku-5-5");

  const verdict = await judge.judge({
    criteria: "Calls send_email once.",
    run: "1. send_email ok",
  });

  assert.deepStrictEqual(verdict, {
    pass: true,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
  });
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: "Criteria:\nCalls send_email once.\n\nThe run:\n1. send_email ok",
        },
      ],
      output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA }, effort: "low" },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-5-5", "eval_gate_judge"));
});

test("the judge on EVAL_GATE_JUDGE_MODEL: a 4.x model gets the schema and no effort, under the feature given", async () => {
  stubFetch([() => message('{"pass":false}')]);
  const { judge } = resolveEvalModels(
    { ...ENV, EVAL_GATE_JUDGE_MODEL: "claude-haiku-4-5" },
    "eval_gate_task_judge",
    "production",
  );
  assert.ok(judge);

  await judge.judge({ criteria: "C", run: "R" });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: "Criteria:\nC\n\nThe run:\nR" }],
      output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-4-5", "eval_gate_task_judge"));
});

test("the tool stand-in: the tool, its schema, the call and up to three recorded results", async () => {
  stubFetch([() => message(' {"error":"nope"} '), () => message("")]);
  const { tool } = resolveEvalModels(ENV, "eval_gate_judge", "production");
  assert.ok(tool);
  assert.equal(tool.model, "claude-haiku-5-5");

  const answered = await tool.answer({
    tool: TOOLS[1]!,
    name: "send_email",
    args: { to: "ada@example.com" },
    examples: ["r1", "r2", "r3", "r4"],
  });
  const unknown = await tool.answer({ tool: null, name: "mystery", args: {}, examples: [] });

  assert.deepStrictEqual(answered, {
    content: '{"error":"nope"}',
    isError: true,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
  });
  assert.deepStrictEqual(unknown, {
    content: "{}",
    isError: false,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
  });
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: STAND_IN_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            "Tool: send_email",
            "Description: Send an email.",
            'Arguments schema: {"type":"object","properties":{"to":{"type":"string"},"body":{"type":"string"}},"required":["to"]}',
            'Called with: {"to":"ada@example.com"}',
            "Results it returned in the recorded run:",
            "r1",
            "r2",
            "r3",
          ].join("\n"),
        },
      ],
      output_config: { effort: "low" },
    }),
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: STAND_IN_SYSTEM,
      messages: [
        {
          role: "user",
          content: "Tool: mystery\nCalled with: {}\nIt has no recorded result in this run.",
        },
      ],
      output_config: { effort: "low" },
    }),
  ]);
  assert.deepStrictEqual(
    [lineOf(0), lineOf(1)],
    [
      okLine("claude-haiku-5-5", "eval_gate_stand_in"),
      okLine("claude-haiku-5-5", "eval_gate_stand_in"),
    ],
  );
});

test("the person: the description and the conversation's words, on the stand-in feature", async () => {
  stubFetch([() => message(" And the receipt? ")]);
  const { person } = resolveEvalModels(ENV, "eval_gate_judge", "production");
  assert.ok(person);
  assert.equal(person.model, "claude-haiku-5-5");

  const written = await person.write({ description: "An impatient customer.", messages: MESSAGES });

  assert.deepStrictEqual(written, {
    text: "And the receipt?",
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
  });
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: PERSON_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            "The person: An impatient customer.",
            "",
            "The conversation so far:",
            "Person: Email Ada her invoice.",
            "Agent: Looking her up.",
            "Person: Thanks.",
            "",
            "Write the person's next message.",
          ].join("\n"),
        },
      ],
      output_config: { effort: "low" },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-5-5", "eval_gate_stand_in"));
});

test("the task judge: always the default small model, on its own feature", async () => {
  stubFetch([() => message('{"pass":true}')]);
  // EVAL_GATE_JUDGE_MODEL is not read here.
  const judge = resolveTaskJudge({ ...ENV, EVAL_GATE_JUDGE_MODEL: "claude-opus-5-5" });
  assert.ok(judge);
  assert.equal(judge.model, "claude-haiku-5-5");

  await judge.judge({ criteria: "C", run: "R" });

  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: "Criteria:\nC\n\nThe run:\nR" }],
      output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA }, effort: "low" },
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-5-5", "eval_gate_task_judge"));
});

test("the test draft: the default small model, the draft prompt, no output_config at all", async () => {
  stubFetch([() => message('{"name":"t"}')]);
  const draft = resolveTestDraftModel({ ...ENV, EVAL_GATE_JUDGE_MODEL: "claude-opus-5-5" });
  assert.ok(draft);
  assert.equal(draft.model, "claude-haiku-5-5");
  assert.equal(draft.standIn, false);

  const drafted = await draft.draft('{"ask":"x"}');

  assert.deepStrictEqual(drafted, {
    text: '{"name":"t"}',
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 },
  });
  assert.match(TEST_DRAFT_PROMPT, /^Create one useful regression test from the recorded run/);
  assert.deepStrictEqual(sent, [
    request({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: TEST_DRAFT_PROMPT,
      messages: [{ role: "user", content: '{"ask":"x"}' }],
    }),
  ]);
  assert.deepStrictEqual(lineOf(0), okLine("claude-haiku-5-5", "eval_gate_task_test_draft"));
});

test("without a key there are no models and nothing is sent", () => {
  stubFetch([() => message("{}")]);
  assert.deepStrictEqual(resolveEvalModels({}, "eval_gate_judge", "production"), {
    agent: null,
    tool: null,
    judge: null,
    standIn: false,
  });
  assert.equal(resolveTaskJudge({}), null);
  assert.equal(resolveTestDraftModel({}), null);
  assert.equal(sent.length, 0);
});
