import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import type { TwinEventPayload } from "../sandbox.js";
import { LiveSpans } from "./live-spans.js";

// The live trace of a playground run: one span.ref event per started and per ended span.

const providers: NodeTracerProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  trace.disable();
  context.disable();
});

function setup() {
  const live = new LiveSpans();
  const provider = new NodeTracerProvider({ spanProcessors: [live.processor] });
  provider.register();
  providers.push(provider);
  return { live, tracer: trace.getTracer("test") };
}

describe("LiveSpans", () => {
  it("sends a start and an end span.ref for each span of a watched trace, root first", () => {
    const { live, tracer } = setup();
    const events: TwinEventPayload[] = [];
    tracer.startActiveSpan(
      "invoke_agent docs-agent",
      { attributes: { "gen_ai.operation.name": "invoke_agent" } },
      (root) => {
        live.watch(root, (e) => events.push(e));
        tracer.startActiveSpan("ai.streamText.doStream", (model) => {
          model.setAttributes({
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "claude-haiku-5-5",
            "gen_ai.usage.input_tokens": 1134,
            "gen_ai.usage.output_tokens": 536,
            "ai.prompt.messages": "a prompt that must stay on the runner",
          });
          model.end();
        });
        root.end();
      },
    );
    const traceId = events[0]?.traceId as string;
    const rootId = events[0]?.spanId as string;
    expect(events.map((e) => [e.kind, e.phase, e.name])).toEqual([
      ["span.ref", "start", "invoke_agent docs-agent"],
      ["span.ref", "start", "ai.streamText.doStream"],
      ["span.ref", "end", "ai.streamText.doStream"],
      ["span.ref", "end", "invoke_agent docs-agent"],
    ]);
    expect(events[2]).toMatchObject({
      traceId,
      parentSpanId: rootId,
      status: "ok",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-haiku-5-5",
        "gen_ai.usage.input_tokens": 1134,
        "gen_ai.usage.output_tokens": 536,
      },
    });
    expect(typeof events[2]?.startMs).toBe("number");
    expect(typeof events[2]?.endMs).toBe("number");
    expect(JSON.stringify(events)).not.toContain("must stay on the runner");
    expect(events[0]?.parentSpanId).toBeUndefined();
  });

  it("marks an errored span and ignores spans of traces it does not watch", () => {
    const { live, tracer } = setup();
    const events: TwinEventPayload[] = [];
    tracer.startActiveSpan("other run", (other) => other.end());
    tracer.startActiveSpan("invoke_workflow label", (root) => {
      live.watch(root, (e) => events.push(e));
      tracer.startActiveSpan("execute_tool search", (tool) => {
        tool.setAttributes({ "gen_ai.tool.name": "search", "ratel.tool.mode": "fake" });
        tool.setStatus({ code: 2, message: "boom" });
        tool.end();
      });
      root.end();
    });
    expect(events.map((e) => e.name)).not.toContain("other run");
    expect(events.find((e) => e.phase === "end" && e.name === "execute_tool search")).toMatchObject(
      {
        status: "error",
        attributes: { "gen_ai.tool.name": "search", "ratel.tool.mode": "fake" },
      },
    );
  });

  it("stops sending once the trace is released", () => {
    const { live, tracer } = setup();
    const events: TwinEventPayload[] = [];
    tracer.startActiveSpan("invoke_agent a", (root) => {
      live.watch(root, (e) => events.push(e));
      live.release(root.spanContext().traceId);
      tracer.startActiveSpan("late", (late) => late.end());
      root.end();
    });
    expect(events.map((e) => e.name)).toEqual(["invoke_agent a"]);
  });
});
