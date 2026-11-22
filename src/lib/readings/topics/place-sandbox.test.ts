import assert from "node:assert/strict";
import { afterEach, beforeEach, type TestContext, test } from "node:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { configHash, resolveParams, runSandbox } from "@ratel-ai/sandbox";
import { withAgentRun } from "@/lib/platform/agent-run";
import {
  recordTracedModelCall,
  setModelCallSink,
  setModelCallTracer,
} from "@/lib/platform/model-call";
import { MODEL_CALL_CONTENT_MAX_CHARS } from "@/lib/platform/model-call-content";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";
import {
  type AssignTopicsDeps,
  assignProjectTopics,
  topicCaseAttributes,
  topicConfigFromEnv,
  topicJudgeFromEnv,
} from "@/lib/readings/topics/job";
import { askCases, TOPIC_FRAMING, topicDefaults, topicOptions } from "@/lib/readings/topics/place";
import placeSandbox, {
  resolveDecisionModel,
  type TopicPlaceInput,
} from "@/lib/readings/topics/place.sandbox";

/**
 * The `topic-place` sandbox and its production stamps behind `FF_SANDBOXES` (RC-1092).
 *
 * Owned (ADR-0030): OpenAI is the one decision engine here, so the private engines' cases and
 * keys are gone; the same stamps and config hash are pinned through the OpenAI engine.
 */

const INPUT: TopicPlaceInput = {
  ask: "Move my flight to Friday",
  topics: [
    { topicId: "t-change", name: "Change a booking", description: "Move or cancel a trip." },
    { topicId: "t-refund", name: "Get a refund", description: "Money back." },
  ],
};
const RUN = {
  name: "assign_topics",
  conversationId: "job-1",
  ask: "Read the topics of project p-1",
};
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "DECISION_ENGINE",
  "DECISION_ENGINE_FALLBACK",
  "OPENAI_DECISIONS_MODEL",
  "OPENAI_BASE_URL",
];
const OPENAI_ENV = {
  DECISION_ENGINE: "openai",
  OPENAI_API_KEY: "k",
  DECISION_ENGINE_FALLBACK: "off",
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const restores: Array<() => void> = [];

beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  restores.push(
    setModelCallTracer(provider.getTracer(MODEL_CALL_TRACER)),
    setModelCallSink({ info: () => {}, warn: () => {} }),
    () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  );
});

afterEach(async () => {
  while (restores.length) restores.pop()?.();
  context.disable();
  await provider.shutdown();
});

/** A fake OpenAI Decisions endpoint: every question answers `choice` at `confidence`; the bodies it got are kept. */
function fakeOpenAI(t: TestContext, choice: string, confidence: number): string[] {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: { body: string }) => {
    bodies.push(init.body);
    const answers = [
      {
        type: "choice",
        name: "tool",
        choice,
        confidence,
        probabilities: [{ value: choice, probability: confidence }],
      },
    ];
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return bodies;
}

test("the sandbox's baseline hash is the production hash on the OpenAI engine", () => {
  assert.equal(resolveParams(placeSandbox, {}).configHash, configHash(topicDefaults));
  assert.deepEqual(topicConfigFromEnv(OPENAI_ENV), topicDefaults);
  assert.equal(
    topicConfigFromEnv({ DECISION_ENGINE: "openai", DECISION_ENGINE_FALLBACK: "off" }),
    null,
    "no usable engine: nothing to stamp",
  );
  const other = topicConfigFromEnv({ ...OPENAI_ENV, OPENAI_DECISIONS_MODEL: "gpt-7" });
  assert.equal(other?.model, "openai/gpt-7");
  assert.notEqual(
    configHash(other ?? topicDefaults),
    configHash(topicDefaults),
    "another model, another hash",
  );
});

test("the model param resolves through the decision engine only", () => {
  assert.deepEqual(resolveDecisionModel("openai/gpt-6-luna"), {
    engine: "openai",
    model: "gpt-6-luna",
  });
  assert.throws(() => resolveDecisionModel("anthropic/claude-sonnet-5-5"), /not an openai\/ model/);
  assert.throws(() => resolveDecisionModel("gpt-6-luna"), /not an openai\/ model/);
});

test("sandbox run: the engine picks a topic, and --set minConfidence=0.99 reaches its config", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  const bodies = fakeOpenAI(t, "t-change", 0.9);

  const baseline = await runSandbox(placeSandbox, { input: INPUT, overrides: {} });
  assert.deepEqual(baseline.output, { topicId: "t-change", confidence: 0.9 });

  const strict = await runSandbox(placeSandbox, {
    input: INPUT,
    overrides: { minConfidence: 0.99, about: "SENTINEL about" },
  });
  assert.deepEqual(
    strict.output,
    { topicId: null, confidence: 0.9 },
    "0.9 is below 0.99: the engine abstains",
  );
  assert.deepEqual(strict.overrides, ["about", "minConfidence"]);

  assert.ok(bodies.length >= 2);
  assert.equal(JSON.parse(bodies[0] ?? "{}").model, "gpt-6-luna");
  assert.ok(bodies.at(-1)?.includes("SENTINEL about"));
});

test("sandbox run: none of these is no topic", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  fakeOpenAI(t, "none", 0.95);
  const result = await runSandbox(placeSandbox, { input: INPUT, overrides: {} });
  assert.equal((result.output as { topicId: string | null }).topicId, null);
});

test("sandbox run without the engine's key says which key", async () => {
  await assert.rejects(runSandbox(placeSandbox, { input: INPUT, overrides: {} }), /OPENAI_API_KEY/);
});

function stopAfterOneCall(sandbox: boolean | undefined): Partial<AssignTopicsDeps> {
  const readingStart = (async () => {
    recordTracedModelCall(
      {
        provider: "openai",
        model: "gpt-6-luna",
        feature: "topics_place",
        payer: "ratel",
        outcome: "ok",
        durationMs: 1,
      },
      Date.now(),
    );
    throw new Error("stop after the first call");
  }) as unknown as AssignTopicsDeps["readingStart"];
  return {
    ...(sandbox === undefined ? {} : { sandbox }),
    judge: null,
    sentimentJudge: null,
    name: null,
    observability: { trackSystemEvent: async () => {} },
    readingStart,
  };
}

const sandboxKeys = (attributes: Record<string, unknown>) =>
  Object.keys(attributes).filter((k) => k.startsWith("ratel.sandbox."));

test("flag on: the assign_topics root carries the sandbox id and the config hash", async () => {
  Object.assign(process.env, OPENAI_ENV);
  await assert.rejects(
    withAgentRun(RUN, () => assignProjectTopics("p1", stopAfterOneCall(true))),
    /stop after/,
  );
  const root = exporter
    .getFinishedSpans()
    .find((s) => s.attributes["gen_ai.operation.name"] === "invoke_agent");
  assert.ok(root);
  assert.equal(root.attributes["ratel.sandbox.id"], "topic-place");
  assert.equal(root.attributes["ratel.sandbox.config_hash"], configHash(topicDefaults));
});

test("flag on: each placement call's span carries its sandbox input, capped", async (t) => {
  fakeOpenAI(t, "t-change", 0.9);
  const judge = topicJudgeFromEnv(TOPIC_FRAMING, OPENAI_ENV, "topics_place", {
    caseAttributes: topicCaseAttributes,
  });
  assert.ok(judge);
  const long = "x".repeat(MODEL_CALL_CONTENT_MAX_CHARS * 2);
  await withAgentRun(RUN, () =>
    judge.judge(
      askCases([
        { hash: "h1", text: INPUT.ask },
        { hash: "h2", text: long },
      ]),
      topicOptions(INPUT.topics),
    ),
  );
  const items = exporter
    .getFinishedSpans()
    .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
  assert.equal(items.length, 2);
  const stamps = items.map((s) => s.attributes["ratel.sandbox.input"] as string);
  assert.ok(stamps.some((stamp) => stamp === JSON.stringify(INPUT)));
  for (const stamp of stamps) {
    assert.ok(stamp.length <= MODEL_CALL_CONTENT_MAX_CHARS, "capped like Ratel-paid content");
  }
});

test("flag off or absent: no sandbox attribute on any span", async (t) => {
  fakeOpenAI(t, "t-change", 0.9);
  Object.assign(process.env, OPENAI_ENV);
  for (const sandbox of [false, undefined]) {
    exporter.reset();
    await assert.rejects(
      withAgentRun(RUN, () => assignProjectTopics("p1", stopAfterOneCall(sandbox))),
      /stop after/,
    );
    const judge = topicJudgeFromEnv(TOPIC_FRAMING, OPENAI_ENV, "topics_place");
    assert.ok(judge);
    await withAgentRun(RUN, () =>
      judge.judge(askCases([{ hash: "h1", text: INPUT.ask }]), topicOptions(INPUT.topics)),
    );
    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 4);
    for (const span of spans) assert.deepEqual(sandboxKeys(span.attributes), [], span.name);
  }
});
