import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { withProviders } from "@/lib/readings/models";
import { vendorAdapters } from "@/lib/readings/models/providers";
import { resetJsonModes } from "@/lib/readings/models/providers/chat-completions";
import {
  ModelRefused,
  recordBudgetRefusal,
  recordNoModelKey,
  resolveEvalModels,
  resolveTaskJudge,
  resolveTestDraftModel,
  SpendMeter,
} from "./models";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

/**
 * The eval gate on a vendor whose model is not Claude (ADR-0009 §11). The Claude path is held by
 * `models.golden.test.ts`.
 */

// A Claude key is present on purpose: naming another vendor must be enough to keep Claude out.
const LITELLM = {
  MODEL_PROVIDER: "litellm",
  MODEL_BASE_URL: "http://gateway.test",
  MODEL: "small",
  MODEL_FEATURE_EVAL_GATE_REPLAY: "big",
  ANTHROPIC_API_KEY: "sk-ant",
};
const OPENAI = {
  MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-openai",
  ANTHROPIC_API_KEY: "sk-ant",
};

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

let seen: Seen[] = [];
let answers: Array<() => Response> = [];
let restore: Array<() => void> = [];
let lines: Record<string, unknown>[] = [];
let realFetch: typeof fetch;

const completion =
  (message: Record<string, unknown>, status = 200) =>
  () =>
    new Response(
      JSON.stringify(
        status === 200
          ? {
              model: "served",
              choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 10 },
            }
          : message,
      ),
      { status },
    );

beforeEach(() => {
  seen = [];
  answers = [];
  lines = [];
  resetJsonModes();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a call went around the vendor");
  }) as typeof fetch;
  const vendor = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = answers.shift();
    if (!next) throw new Error("the fake vendor has no answer left");
    return next();
  }) as typeof fetch;
  restore = [
    withProviders(vendorAdapters({ fetch: vendor, sleep: async () => {} })),
    setModelCallSink({
      info: (fields) => void lines.push(fields),
      warn: (fields) => void lines.push(fields),
    }),
  ];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const undo of restore) undo();
});

const resolve = (env: Record<string, string> = LITELLM) =>
  resolveEvalModels(cfg(env), "eval_gate_judge", "production");

const TOOLS = [{ name: "crm.lookup", description: "Find", parameters: {} }];

test("every model is the named vendor's, and a Claude key is not used", async () => {
  const models = resolve();
  const agent = models.agent?.({ recordedModel: "claude-opus-5-5", recorded: [] });
  assert.equal(agent?.model, "big");
  assert.equal(models.tool?.model, "small");
  assert.equal(models.judge?.model, "small");
  assert.equal(models.person?.model, "small");
  assert.equal(models.standIn, false);

  answers.push(
    completion({ content: "Done." }),
    completion({ content: '{"id":1}' }),
    completion({ content: '{"pass":true}' }),
    completion({ content: " Hello? " }),
  );
  const reply = await agent?.next({
    system: "You help.",
    tools: TOOLS,
    messages: [{ role: "user", text: "hi" }],
  });
  assert.equal(reply?.text, "Done.");
  assert.equal(reply?.model, "big");
  assert.deepEqual(
    await models.tool?.answer({ tool: TOOLS[0], name: "crm.lookup", args: {}, examples: [] }),
    { content: '{"id":1}', isError: false, usage: { inputTokens: 100, outputTokens: 10 } },
  );
  assert.equal((await models.judge?.judge({ criteria: "c", run: "r" }))?.pass, true);
  assert.equal(
    (await models.person?.write({ description: "d", messages: [{ role: "user", text: "hi" }] }))
      ?.text,
    "Hello?",
  );
  for (const call of seen) assert.equal(call.url, "http://gateway.test/v1/chat/completions");
  assert.deepEqual(
    lines.map((line) => [line.provider, line.feature]),
    [
      ["litellm", "eval_gate_replay"],
      ["litellm", "eval_gate_stand_in"],
      ["litellm", "eval_gate_judge"],
      ["litellm", "eval_gate_stand_in"],
    ],
  );
});

test("a tool call round-trips: the call comes back, and its result goes with the turn that asked", async () => {
  const written = {
    content: "",
    tool_calls: [
      {
        id: "abcDEF123",
        type: "function",
        function: { name: "crm_lookup", arguments: '{"q":"acme"}' },
      },
    ],
  };
  answers.push(completion(written), completion({ content: "Acme is a customer." }));
  const agent = resolve().agent?.({ recordedModel: null, recorded: [] });
  const ask = { role: "user" as const, text: "Who is Acme?" };
  const first = await agent?.next({ system: undefined, tools: TOOLS, messages: [ask] });
  assert.deepEqual(first?.calls, [{ id: "abcDEF123", name: "crm.lookup", args: { q: "acme" } }]);
  const second = await agent?.next({
    system: undefined,
    tools: TOOLS,
    messages: [
      ask,
      { role: "assistant", text: "", calls: first?.calls ?? [], raw: first?.raw },
      { role: "tool", callId: "abcDEF123", content: "Acme Inc.", isError: false },
    ],
  });
  assert.equal(second?.text, "Acme is a customer.");
  const sent = seen[1].body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(sent[1], { role: "assistant", ...written });
  assert.equal(sent[2].tool_call_id, "abcDEF123");
});

test("a run recorded on the vendor's own model is replayed on it, and on the default once it is gone", async () => {
  const agent = resolve(OPENAI).agent?.({ recordedModel: "gpt-5.6-sol", recorded: [] });
  assert.equal(agent?.model, "gpt-5.6-sol");
  const response = (text: string) => () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
  answers.push(completion({ message: "no such model" }, 404), response("a"), response("b"));
  const turn = {
    system: undefined,
    tools: [],
    messages: [{ role: "user" as const, text: "hi" }],
  };
  assert.equal((await agent?.next(turn))?.model, "gpt-6.2-astra");
  assert.equal((await agent?.next(turn))?.model, "gpt-6.2-astra");
  assert.deepEqual(
    seen.map((call) => call.body.model),
    ["gpt-5.6-sol", "gpt-6.2-astra", "gpt-6.2-astra"],
  );
});

test("a run recorded on another vendor's model is replayed on this one's", () => {
  for (const recordedModel of ["gpt-6.2-sol", "claude-opus-5-5", "gemini-4-carbon", null])
    assert.equal(resolve().agent?.({ recordedModel, recorded: [] })?.model, "big");
});

test("a refused key stops the simulation, as on Claude", async () => {
  answers.push(completion({ message: "bad key" }, 401));
  await assert.rejects(
    async () => resolve().judge?.judge({ criteria: "c", run: "r" }),
    ModelRefused,
  );
});

test("a verdict is read out of words and a code fence; an answer without one is an error", async () => {
  answers.push(
    completion({ content: 'Here you go:\n```json\n{"pass": false}\n```' }),
    completion({ content: '{"verdict":"yes"}' }),
    completion({ content: '{"verdict":"yes"}' }),
    completion({ content: '{"verdict":"yes"}' }),
  );
  const judge = resolve().judge;
  assert.equal((await judge?.judge({ criteria: "c", run: "r" }))?.pass, false);
  await assert.rejects(async () => judge?.judge({ criteria: "c", run: "r" }), /without a verdict/);
});

test("the live task judge and the test draft run on the vendor too", async () => {
  answers.push(completion({ content: '{"pass":true}' }), completion({ content: "{}" }));
  const judge = resolveTaskJudge(cfg(LITELLM));
  assert.equal(judge?.model, "small");
  await judge?.judge({ criteria: "c", run: "r" });
  const draft = resolveTestDraftModel(cfg(LITELLM));
  assert.equal(draft?.model, "small");
  await draft?.draft("{}");
  assert.deepEqual(
    lines.map((line) => line.feature),
    ["eval_gate_task_judge", "eval_gate_task_test_draft"],
  );
});

test("naming a vendor that cannot run leaves no model, though Claude is configured", () => {
  for (const env of [
    { MODEL_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant" },
    { MODEL_PROVIDER: "ollama", ANTHROPIC_API_KEY: "sk-ant" },
    { MODEL_PROVIDER: "typo", ANTHROPIC_API_KEY: "sk-ant" },
  ]) {
    const models = resolve(env);
    assert.equal(models.agent, null);
    assert.equal(models.tool, null);
    assert.equal(models.judge, null);
    assert.equal(models.person ?? null, null);
    assert.equal(resolveTaskJudge(cfg(env)), null);
    assert.equal(resolveTestDraftModel(cfg(env)), null);
  }
});

test("one feature can run on another of the vendor's models", () => {
  const models = resolve({ ...LITELLM, MODEL_FEATURE_EVAL_GATE_JUDGE: "big" });
  assert.equal(models.judge?.model, "big");
  assert.equal(models.tool?.model, "small");
});

test("a call refused for its budget, or never made, names the vendor", () => {
  const judge = resolve().judge;
  assert.ok(judge);
  recordBudgetRefusal(judge, "eval_gate_judge");
  recordNoModelKey("eval_gate_judge", 1, cfg(LITELLM));
  assert.deepEqual(
    lines.map((line) => [line.provider, line.outcome]),
    [
      ["litellm", "refused_budget"],
      ["litellm", "skipped_no_key"],
    ],
  );
});

test("the meter prices a vendor's model at its own rate, and an unknown one high", () => {
  const meter = new SpendMeter(1);
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  assert.equal(meter.price("gpt-6.2-sol", usage), 2);
  assert.equal(meter.price("gpt-6.2-astra", usage), 8);
  assert.equal(meter.price("who-knows", usage), 5);
});
