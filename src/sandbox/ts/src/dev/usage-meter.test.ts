import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { UsageMeter } from "./usage-meter.js";

// The usage a worker measures for run.end (RC-1234): the tokens of every model
// call of the run's trace, read from the spans as they end, so run.end carries
// them whatever the trace export does.

function setup() {
  const meter = new UsageMeter();
  const provider = new BasicTracerProvider({ spanProcessors: [meter] });
  return { meter, tracer: provider.getTracer("test") };
}

describe("UsageMeter", () => {
  it("sums the model calls of one trace, with each call's model, and forgets the trace once taken", () => {
    const { meter, tracer } = setup();
    const root = tracer.startSpan("run");
    const traceId = root.spanContext().traceId;
    {
      const ctx = trace.setSpan(context.active(), root);
      // The AI SDK's outer span carries ai.usage totals only: it is not a model call.
      tracer.startSpan("ai.streamText", { attributes: { "ai.usage.inputTokens": 999 } }, ctx).end();
      tracer
        .startSpan(
          "chat",
          {
            attributes: {
              "gen_ai.request.model": "claude-sonnet-5-5",
              "gen_ai.response.model": "eu.anthropic.claude-sonnet-5-5",
              "gen_ai.system": "amazon-bedrock",
              "gen_ai.usage.input_tokens": 120,
              "gen_ai.usage.output_tokens": 30,
            },
          },
          ctx,
        )
        .end();
      tracer
        .startSpan(
          "chat",
          {
            attributes: {
              "gen_ai.request.model": "claude-haiku-5-5",
              "gen_ai.usage.input_tokens": 80,
              "gen_ai.usage.output_tokens": 5,
            },
          },
          ctx,
        )
        .end();
      root.end();
    }
    expect(meter.take(traceId)).toEqual({
      inputTokens: 200,
      outputTokens: 35,
      calls: [
        {
          model: "eu.anthropic.claude-sonnet-5-5",
          provider: "amazon-bedrock",
          inputTokens: 120,
          outputTokens: 30,
        },
        { model: "claude-haiku-5-5", inputTokens: 80, outputTokens: 5 },
      ],
    });
    expect(meter.take(traceId)).toBeUndefined();
  });

  it("keeps traces apart and has nothing for a trace with no model call", () => {
    const { meter, tracer } = setup();
    const a = tracer.startSpan("chat", {
      attributes: {
        "gen_ai.request.model": "m",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 2,
      },
    });
    a.end();
    const b = tracer.startSpan("tool");
    b.end();
    expect(meter.take(b.spanContext().traceId)).toBeUndefined();
    expect(meter.take(a.spanContext().traceId)?.inputTokens).toBe(1);
  });
});
