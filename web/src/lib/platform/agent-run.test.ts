import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withAgentRun } from "@/lib/platform/agent-run";
import { runWithLogContext } from "@/lib/platform/logger";
import {
  anthropicUsage,
  type ModelCallMeta,
  recordTracedModelCall,
  setModelCallSink,
  setModelCallTracer,
  trackModelCall,
} from "@/lib/platform/model-call";
import { anthropicContent } from "@/lib/platform/model-call-content";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";

/**
 * Owned (ADR-0004): upstream also turns off its model-call lines' project label lookup here; this
 * edition's lines read their labels from the log context, so there is no lookup to turn off.
 */

const META: ModelCallMeta = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  feature: "workflow_label",
  payer: "ratel",
};
const ANSWER = {
  content: [{ type: "text" as const, text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};
const RUN = {
  name: "label_workflows",
  conversationId: "job-1",
  ask: "Label the workflows of project p-1",
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;
const restores: Array<() => void> = [];

beforeEach(() => {
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  restores.push(
    setModelCallTracer(provider.getTracer(MODEL_CALL_TRACER)),
    setModelCallSink({ info: () => {}, warn: () => {} }),
  );
});

afterEach(async () => {
  while (restores.length) restores.pop()!();
  context.disable();
  await provider.shutdown();
});

const spans = () => exporter.getFinishedSpans();
const roots = () =>
  spans().filter((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent");
const inOrg = <T>(work: () => Promise<T>) =>
  runWithLogContext({ org_id: "org-a", project_id: "p-1" }, work);

function twoCalls(): Promise<unknown> {
  return Promise.all([
    trackModelCall(
      { ...META, content: anthropicContent({ messages: [{ role: "user", content: "one" }] }) },
      async () => ANSWER,
      anthropicUsage,
    ),
    trackModelCall(META, async () => ANSWER, anthropicUsage),
  ]);
}

test("one job is one trace, an invoke_agent root with the ask and its chat calls as children", async () => {
  await inOrg(() => withAgentRun(RUN, twoCalls));

  const [root] = roots();
  assert.ok(root, "an invoke_agent root");
  const children = spans().filter((span) => span !== root);
  assert.equal(children.length, 2);
  assert.equal(root.name, "invoke_agent label_workflows");
  assert.equal(root.instrumentationScope.name, MODEL_CALL_TRACER);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(root.attributes["gen_ai.agent.name"], "label_workflows");
  assert.equal(root.attributes["gen_ai.conversation.id"], "job-1");
  assert.deepEqual(JSON.parse(String(root.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "Label the workflows of project p-1" }] },
  ]);
  for (const child of children) {
    assert.equal(child.spanContext().traceId, root.spanContext().traceId);
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(child.attributes["gen_ai.operation.name"], "chat");
  }
  assert.ok(spanStart(root) <= Math.min(...children.map(spanStart)));
});

test("the run's root is a new trace even inside an outer request span, and stays out of the active context", async () => {
  const outer = provider.getTracer("http").startSpan("POST /api/cron/drain");
  await context.with(trace.setSpan(context.active(), outer), () =>
    inOrg(() =>
      withAgentRun(RUN, async () => {
        assert.equal(trace.getSpan(context.active()), outer);
        await trackModelCall(META, async () => ANSWER, anthropicUsage);
      }),
    ),
  );
  outer.end();
  const [root] = roots();
  assert.equal(root!.parentSpanContext, undefined);
  assert.notEqual(root!.spanContext().traceId, outer.spanContext().traceId);
});

test("a run that makes no model call exports nothing", async () => {
  await inOrg(() => withAgentRun(RUN, async () => "no model needed"));
  assert.equal(spans().length, 0);
});

test("a run that throws ends its root as an error with the class name, and rethrows", async () => {
  class LabelError extends Error {}
  await assert.rejects(
    inOrg(() =>
      withAgentRun(RUN, async () => {
        await trackModelCall(META, async () => ANSWER, anthropicUsage);
        throw new LabelError("customer text");
      }),
    ),
    LabelError,
  );
  const [root] = roots();
  assert.equal(root!.status.code, SpanStatusCode.ERROR);
  assert.equal(root!.attributes["error.type"], "LabelError");
  assert.ok(!JSON.stringify(root!.attributes).includes("customer text"));
});

test("the run returns what its work returned", async () => {
  assert.equal(await inOrg(() => withAgentRun(RUN, async () => 42)), 42);
});

test("a call logged after the fact (the Jev judge) is a span from its start, a child of the run", async () => {
  const startedAt = Date.now() - 1_500;
  await inOrg(() =>
    withAgentRun(RUN, async () => {
      recordTracedModelCall(
        {
          ...META,
          provider: "typesafe",
          model: "jev-1",
          feature: "match_quality_judge",
          inputTokens: 900,
          outcome: "ok",
          durationMs: 1_500,
        },
        startedAt,
      );
    }),
  );
  const [root] = roots();
  const judge = spans().find(
    (span) => span.attributes["gen_ai.agent.name"] === "match_quality_judge",
  );
  assert.ok(judge, "a judge span");
  assert.equal(judge.name, "chat jev-1");
  assert.equal(judge.attributes["gen_ai.usage.input_tokens"], 900);
  assert.equal(judge.parentSpanContext?.spanId, root!.spanContext().spanId);
  assert.ok(Math.abs(spanStart(judge) - startedAt) < 5);
});

test("a Jev judge call outside any run is its own span; an error call is an error span", async () => {
  recordTracedModelCall(
    {
      ...META,
      provider: "typesafe",
      model: "jev-1",
      feature: "match_quality_judge",
      outcome: "error",
      durationMs: 10,
      error: new TypeError("x"),
    },
    Date.now() - 10,
  );
  const [judge] = spans();
  assert.equal(judge!.status.code, SpanStatusCode.ERROR);
  assert.equal(judge!.attributes["error.type"], "TypeError");
});

function spanStart(span: ReadableSpan): number {
  return span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000;
}
