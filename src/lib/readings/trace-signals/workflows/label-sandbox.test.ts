import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { configHash, resolveParams } from "@ratel-ai/sandbox";
import { withAgentRun } from "@/lib/platform/agent-run";
import { setModelCallSink, setModelCallTracer, trackModelCall } from "@/lib/platform/model-call";
import { MODEL_CALL_CONTENT_MAX_CHARS } from "@/lib/platform/model-call-content";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";
import {
  type LabelInput,
  labelDefaults,
  labelInputHash,
} from "@/lib/readings/trace-signals/workflows/label";
import labelSandbox from "@/lib/readings/trace-signals/workflows/label.sandbox";
import {
  type LabelJobDeps,
  labelProjectWorkflows,
} from "@/lib/readings/trace-signals/workflows/label-job";

/** The `workflow-label` sandbox and its production stamps behind `cloud-sandboxes` (RC-1091). */

const INPUT: LabelInput = {
  workflowId: "wf-1",
  typicalOrder: ["find_pr", "merge_pr"],
  optionalTools: ["notify"],
  tools: [{ id: "find_pr", name: "find_pr", description: "Find a PR." }],
  asks: ["Ship the fix"],
};
const RUN = {
  name: "label_workflows",
  conversationId: "job-1",
  ask: "Label the workflows of project p-1",
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const restores: Array<() => void> = [];

beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
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

test("flag off: the cache key is the pre-sandbox key, byte for byte", () => {
  const tools = [...INPUT.tools].sort((a, b) => a.id.localeCompare(b.id));
  const before = createHash("sha256")
    .update(
      JSON.stringify([4, INPUT.typicalOrder, INPUT.optionalTools, tools, INPUT.asks.length > 0]),
    )
    .digest("hex")
    .slice(0, 32);
  assert.equal(labelInputHash(INPUT), before);
  assert.equal(labelInputHash(INPUT, null), before);
});

test("flag on: the cache key follows the config hash", () => {
  const baseline = labelInputHash(INPUT, configHash(labelDefaults));
  assert.notEqual(
    baseline,
    labelInputHash(INPUT),
    "turning the flag on names each workflow once more",
  );
  assert.equal(
    baseline,
    labelInputHash(INPUT, configHash({ ...labelDefaults })),
    "same values, same key",
  );
  for (const changed of [
    { model: "anthropic/claude-haiku-5-5" },
    { system: `${labelDefaults.system}\nBe brief.` },
    { maxTokens: 401 },
  ]) {
    assert.notEqual(
      labelInputHash(INPUT, configHash({ ...labelDefaults, ...changed })),
      baseline,
      JSON.stringify(Object.keys(changed)),
    );
  }
});

test("the sandbox's baseline hash is the production hash", () => {
  assert.equal(resolveParams(labelSandbox, {}).configHash, configHash(labelDefaults));
  assert.notEqual(
    resolveParams(labelSandbox, { maxTokens: 200 }).configHash,
    configHash(labelDefaults),
  );
});

function deps(sandbox: boolean | undefined): Partial<LabelJobDeps> {
  return {
    model: "claude-sonnet-5-5",
    ...(sandbox === undefined ? {} : { sandbox }),
    complete: (_system, _user, spanAttributes) =>
      trackModelCall(
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          feature: "workflow_label",
          payer: "ratel",
          spanAttributes,
        },
        async () =>
          JSON.stringify({
            name: "Close out a release",
            description: "Merges it.",
            icon: "rocket",
          }),
      ),
    loadLatestWorkflows: async () => [
      {
        id: "wf-1",
        typicalOrder: ["find_pr"],
        coreTools: ["find_pr"],
        optionalTools: [],
        exampleTurnIds: ["t1"],
      },
    ],
    loadToolDocs: async () => [],
    loadTurnAsks: async () => ["x".repeat(MODEL_CALL_CONTENT_MAX_CHARS * 2)],
    loadLabelHashes: async () => new Map(),
    saveLabel: async () => {},
    loadWorkflowLabels: async () => new Map(),
    decide: null,
  };
}

const sandboxKeys = (attributes: Record<string, unknown>) =>
  Object.keys(attributes).filter((k) => k.startsWith("ratel.sandbox."));

test("flag on: the invoke_agent root carries the sandbox id and config hash, the item span its input", async () => {
  await withAgentRun(RUN, () => labelProjectWorkflows("p1", deps(true)));
  const spans = exporter.getFinishedSpans();
  const root = spans.find((s) => s.attributes["gen_ai.operation.name"] === "invoke_agent");
  const item = spans.find((s) => s.attributes["gen_ai.operation.name"] === "chat");
  assert.ok(root && item);
  assert.equal(root.attributes["ratel.sandbox.id"], "workflow-label");
  assert.equal(root.attributes["ratel.sandbox.config_hash"], configHash(labelDefaults));
  assert.equal(item.parentSpanContext?.spanId, root.spanContext().spanId);
  const stamped = item.attributes["ratel.sandbox.input"];
  assert.equal(typeof stamped, "string");
  assert.ok(
    (stamped as string).length <= MODEL_CALL_CONTENT_MAX_CHARS,
    "capped like Ratel-paid content",
  );
  assert.ok((stamped as string).startsWith('{"workflowId":"wf-1"'));
  assert.deepEqual(sandboxKeys(item.attributes), ["ratel.sandbox.input"]);
});

test("flag off or absent: no sandbox attribute on any span", async () => {
  for (const sandbox of [false, undefined]) {
    exporter.reset();
    await withAgentRun(RUN, () => labelProjectWorkflows("p1", deps(sandbox)));
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    for (const span of spans) assert.deepEqual(sandboxKeys(span.attributes), [], span.name);
  }
});

test("no production source imports a sandbox file", () => {
  // Owned (ADR-0030): the app is src here, four levels up (upstream's apps/web is three).
  const root = path.resolve(import.meta.dirname, "../../../..");
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|sandbox)\.tsx?$/.test(entry.name)) {
        if (/from\s+["'][^"']*\.sandbox["']/.test(readFileSync(file, "utf8")))
          importers.push(path.relative(root, file));
      }
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(path.join(root, dir));
  assert.deepEqual(importers, []);
});

test("sandbox run: --set overrides reach the request sent to the model", async (t) => {
  const { runSandbox } = await import("@ratel-ai/sandbox");
  const sent: Array<{ model: string; max_tokens: number; system: string }> = [];
  const env = { key: process.env.ANTHROPIC_API_KEY, backend: process.env.ANTHROPIC_BACKEND };
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BACKEND;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const text = JSON.stringify({
      name: "Close out a release",
      description: "Merges it.",
      icon: "rocket",
    });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  t.after(() => {
    if (env.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = env.key;
    if (env.backend !== undefined) process.env.ANTHROPIC_BACKEND = env.backend;
  });

  const result = await runSandbox(labelSandbox, {
    input: INPUT,
    overrides: {
      model: "anthropic/claude-haiku-5-5",
      system: "SENTINEL system prompt",
      maxTokens: 200,
    },
  });
  assert.deepEqual(result.output, {
    name: "Close out a release",
    description: "Merges it.",
    icon: "rocket",
  });
  assert.deepEqual(result.overrides, ["model", "system", "maxTokens"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, "claude-haiku-5-5");
  assert.equal(sent[0].max_tokens, 200);
  assert.equal(sent[0].system, "SENTINEL system prompt");
});
