import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  MODEL_CALL_TRACER,
  RATEL_SELF_TELEMETRY_PROJECT_ENV,
} from "@/lib/contracts/self-telemetry";
import { runWithLogContext } from "@/lib/platform/logger";
import {
  anthropicUsage,
  type ModelCallMeta,
  setModelCallSink,
  setModelCallTracer,
  trackModelCall,
} from "@/lib/platform/model-call";

const META: ModelCallMeta = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  feature: "workflow_label",
  payer: "ratel",
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const restores: Array<() => void> = [];

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  restores.push(
    setModelCallTracer(provider.getTracer(MODEL_CALL_TRACER)),
    setModelCallSink({ info: () => {}, warn: () => {} }),
  );
});

afterEach(async () => {
  while (restores.length) restores.pop()!();
  delete process.env[RATEL_SELF_TELEMETRY_PROJECT_ENV];
  await provider.shutdown();
});

const spans = () => exporter.getFinishedSpans();

test("a Ratel-paid call becomes one gen_ai chat span with its tokens and the feature as the agent", async () => {
  const answer = {
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    },
  };
  const result = await trackModelCall(META, async () => answer, anthropicUsage);

  assert.equal(result, answer);
  assert.equal(spans().length, 1);
  const span = spans()[0]!;
  assert.equal(span.name, "chat claude-haiku-4-5");
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.instrumentationScope.name, MODEL_CALL_TRACER);
  assert.deepEqual(span.attributes, {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-haiku-4-5",
    "gen_ai.agent.name": "workflow_label",
    "gen_ai.usage.input_tokens": 450,
    "gen_ai.usage.output_tokens": 20,
    "gen_ai.usage.cache_read.input_tokens": 300,
    "gen_ai.usage.cache_creation.input_tokens": 50,
  });
});

test("the span carries no customer ids, prompt or answer", async () => {
  await trackModelCall({ ...META, organizationId: "org-1", projectId: "project-1" }, async () => ({
    text: "secret answer",
  }));
  const values = JSON.stringify(spans()[0]!.attributes);
  assert.ok(!values.includes("org-1"));
  assert.ok(!values.includes("project-1"));
  assert.ok(!values.includes("secret answer"));
});

test("a failed call ends its span as an error with the class name only, and still throws", async () => {
  class RateLimitError extends Error {}
  await assert.rejects(
    trackModelCall(META, async () => {
      throw new RateLimitError("customer text in the message");
    }),
    RateLimitError,
  );
  const span = spans()[0]!;
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, undefined);
  assert.equal(span.attributes["error.type"], "RateLimitError");
  assert.equal(span.attributes["gen_ai.usage.input_tokens"], undefined);
  assert.ok(
    !JSON.stringify({
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    }).includes("customer text"),
  );
});

test("a call the customer pays for makes no span", async () => {
  await trackModelCall({ ...META, feature: "tool_picker", payer: "customer" }, async () => ({}));
  assert.equal(spans().length, 0);
});

// Owned: the core's own calls are chat; the edition's embedding calls go through its own copy.
test("the core's own calls are chat operations", async () => {
  await trackModelCall({ ...META, provider: "openai", model: "gpt-6-luna" }, async () => ({}));
  assert.equal(spans()[0]!.attributes["gen_ai.operation.name"], "chat");
});

test("calls made while analysing the self-telemetry project itself are not traced, so they cannot loop", async () => {
  process.env[RATEL_SELF_TELEMETRY_PROJECT_ENV] = "own-project";
  await trackModelCall({ ...META, projectId: "own-project" }, async () => ({}));
  await runWithLogContext({ project_id: "own-project" }, () =>
    trackModelCall(META, async () => ({})),
  );
  assert.equal(spans().length, 0);

  await trackModelCall({ ...META, projectId: "customer-project" }, async () => ({}));
  assert.equal(spans().length, 1);
});

test("a span stays out of the active context, so the provider's HTTP span keeps its parent", async () => {
  const { trace, context } = await import("@opentelemetry/api");
  await trackModelCall(META, async () => {
    assert.equal(trace.getSpan(context.active()), undefined);
    return {};
  });
});
