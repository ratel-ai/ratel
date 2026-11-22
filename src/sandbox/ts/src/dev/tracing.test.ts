import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { RATEL_SANDBOX_CONFIG_HASH, resolveLocal } from "../otel.js";
import { labelDefaults, labelSandbox } from "../test-support/label.sandbox.js";
import { executeRun } from "./execute.js";
import type { RunStartPayload } from "./runs.js";
import { attachPlaygroundExport, PLAYGROUND_ENVIRONMENT, playgroundResource } from "./tracing.js";

// The playground trace contract of spec §10, against in-memory exporters.

const RESOURCE = playgroundResource({
  build: { id: "3f9a1c2e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a", dirty: true },
  runner: { instanceId: "rnr_0123456789abcdef", host: "mbp.local" },
  sdk: { name: "@ratel-ai/sandbox", version: "0.1.0" },
});
const CONFIG = { baseUrl: "http://127.0.0.1:1", apiKey: "rtl_test", resource: RESOURCE };
const SECRET_PROMPT = "a candidate prompt that must stay on the runner";

const providers: NodeTracerProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  trace.disable();
  context.disable();
});

function userProvider(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  providers.push(provider);
  return exporter;
}

function start(params: Record<string, unknown>, extra: Partial<RunStartPayload> = {}) {
  return {
    sandboxId: labelSandbox.id,
    sessionId: "pgs_41c9",
    input: { workflowId: "wf_12", toolOrder: ["search", "read"] },
    params,
    configHash: "0".repeat(64),
    ...extra,
  } satisfies RunStartPayload;
}

async function run(params: Record<string, unknown>, extra: Partial<RunStartPayload> = {}) {
  return executeRun(labelSandbox, {
    runId: "run_7",
    start: start(params, extra),
    tracer: trace.getTracer("@ratel-ai/sandbox"),
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}

function root(spans: ReadableSpan[]): ReadableSpan {
  const span = spans.find((s) => s.name === "invoke_workflow workflow-label");
  if (!span) throw new Error(`no root span in ${spans.map((s) => s.name).join(", ")}`);
  return span;
}

describe("executeRun", () => {
  it("stamps the root span with the sandbox attributes of spec §10", async () => {
    const spans = userProvider();
    const result = await run(
      { maxTokens: 100, system: SECRET_PROMPT },
      {
        replay: {
          sourceTraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          sourceSessionId: "sess_recorded_7",
          arm: "candidate",
        },
      },
    );
    const span = root(spans.getFinishedSpans());
    expect(result).toMatchObject({ status: "ok", traceId: span.spanContext().traceId });
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.conversation.id": "pgs_41c9",
      "ratel.sandbox.id": "workflow-label",
      "ratel.sandbox.run_id": "run_7",
      "ratel.sandbox.config_hash": expect.stringMatching(/^[0-9a-f]{64}$/),
      "ratel.sandbox.overrides": ["system", "maxTokens"],
      "ratel.sandbox.input": JSON.stringify({ workflowId: "wf_12", toolOrder: ["search", "read"] }),
      "ratel.replay.source_trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "ratel.replay.source_session_id": "sess_recorded_7",
      "ratel.replay.arm": "candidate",
    });
  });

  it("lists override names, never values", async () => {
    const spans = userProvider();
    await run({ system: SECRET_PROMPT, model: "anthropic/claude-haiku-5-5" });
    const span = root(spans.getFinishedSpans());
    expect(span.attributes["ratel.sandbox.overrides"]).toEqual(["model", "system"]);
    expect(JSON.stringify(span.attributes)).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(span.attributes)).not.toContain("claude-haiku-5-5");
  });

  it("gives a baseline run the same config hash as resolveLocal in production", async () => {
    const spans = userProvider();
    trace.getTracer("prod").startActiveSpan("invoke_agent label_workflows", (span) => {
      resolveLocal(labelDefaults, { sandbox: "workflow-label" });
      span.end();
    });
    const production = spans.getFinishedSpans()[0]?.attributes[RATEL_SANDBOX_CONFIG_HASH];
    spans.reset();
    await run({});
    expect(root(spans.getFinishedSpans()).attributes[RATEL_SANDBOX_CONFIG_HASH]).toBe(production);
    spans.reset();
    // The controller may send every value explicitly: the defaults still hash the same.
    await run({ ...labelDefaults });
    const explicit = root(spans.getFinishedSpans());
    expect(explicit.attributes[RATEL_SANDBOX_CONFIG_HASH]).toBe(production);
    expect(explicit.attributes["ratel.sandbox.overrides"]).toEqual([]);
  });
});

describe("attachPlaygroundExport", () => {
  it("adds the exporter to the project's provider and merges the playground resource", async () => {
    const userSpans = userProvider();
    const ratel = new InMemorySpanExporter();
    const playground = attachPlaygroundExport(CONFIG, ratel);
    expect(playground.mode).toBe("attached");
    const result = await executeRun(labelSandbox, {
      runId: "run_8",
      start: start({}),
      tracer: trace.getTracer("@ratel-ai/sandbox"),
      signal: new AbortController().signal,
      onEvent: () => {},
      onTrace: (traceId) => playground.track(traceId),
    });
    // A span outside any playground run stays with the project's own exporter.
    trace.getTracer("other").startSpan("background job").end();
    await playground.flush();

    const exported = ratel.getFinishedSpans();
    expect(exported.map((s) => s.name)).toEqual(["invoke_workflow workflow-label"]);
    expect(exported[0]?.spanContext().traceId).toBe(result.traceId);
    expect(exported[0]?.resource.attributes).toMatchObject({
      "deployment.environment.name": PLAYGROUND_ENVIRONMENT,
      "ratel.build.id": "3f9a1c2e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a",
      "ratel.build.dirty": true,
      "ratel.runner.instance_id": "rnr_0123456789abcdef",
      "ratel.runner.host": "mbp.local",
      "ratel.runner.sdk.name": "@ratel-ai/sandbox",
    });
    // The project's own exporter is untouched: its spans keep their resource.
    expect(userSpans.getFinishedSpans().map((s) => s.name)).toContain("background job");
    const own = root(userSpans.getFinishedSpans());
    expect(own.resource.attributes["deployment.environment.name"]).toBeUndefined();
  });

  it("sends the live span.ref events of a watched run on the project's provider", async () => {
    userProvider();
    const playground = attachPlaygroundExport(CONFIG, new InMemorySpanExporter());
    const events: Record<string, unknown>[] = [];
    const result = await executeRun(labelSandbox, {
      runId: "run_10",
      start: start({}),
      tracer: trace.getTracer("@ratel-ai/sandbox"),
      signal: new AbortController().signal,
      onEvent: () => {},
      onTrace: (traceId, rootSpan) => {
        playground.track(traceId);
        playground.live.watch(rootSpan, (e) => events.push(e));
      },
    });
    expect(events.map((e) => [e.kind, e.phase, e.name])).toEqual([
      ["span.ref", "start", "invoke_workflow workflow-label"],
      ["span.ref", "end", "invoke_workflow workflow-label"],
    ]);
    expect(events[1]).toMatchObject({ traceId: result.traceId, status: "ok" });
  });

  it("registers the only provider when the project has none", async () => {
    const ratel = new InMemorySpanExporter();
    const playground = attachPlaygroundExport(CONFIG, ratel);
    expect(playground.mode).toBe("registered");
    const result = await executeRun(labelSandbox, {
      runId: "run_9",
      start: start({}),
      tracer: trace.getTracer("@ratel-ai/sandbox"),
      signal: new AbortController().signal,
      onEvent: () => {},
      onTrace: (traceId) => playground.track(traceId),
    });
    await playground.flush();
    const [span] = ratel.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(result.traceId);
    expect(span?.resource.attributes["deployment.environment.name"]).toBe(PLAYGROUND_ENVIRONMENT);
    // Registering again does not replace it: there is one provider.
    const delegate = (
      trace.getTracerProvider() as unknown as { getDelegate(): unknown }
    ).getDelegate();
    attachPlaygroundExport(CONFIG, new InMemorySpanExporter());
    expect((trace.getTracerProvider() as unknown as { getDelegate(): unknown }).getDelegate()).toBe(
      delegate,
    );
  });
});
