import type { AttrMap, DecodedSpan, IExportTraceServiceRequest, RawKeyValue } from "../types";

export type TypedStepFixtureName = "ratel" | "bareChat" | "stema" | "vibiz" | "cato" | "docs";
const FIXTURE_START = Date.UTC(2026, 10, 20, 12);
const MODEL = {
  "gen_ai.request.model": "claude-sonnet-5-5",
  "gen_ai.usage.input_tokens": 400,
  "gen_ai.usage.output_tokens": 40,
};

/** Synthetic spans preserve the production shapes without customer identifiers or message text. */
export function typedStepFixtures(
  startUnixMs = FIXTURE_START,
): Record<TypedStepFixtureName, DecodedSpan[]> {
  const span = (
    trace: number,
    id: number,
    parent: number | null,
    name: string,
    operation: string | null,
    offset: number,
    duration: number,
    attributes: AttrMap = {},
  ): DecodedSpan => ({
    traceId: trace.toString(16).padStart(32, "0"),
    spanId: (trace * 100 + id).toString(16).padStart(16, "0"),
    parentSpanId: parent === null ? null : (trace * 100 + parent).toString(16).padStart(16, "0"),
    name,
    kind: operation === "chat" ? 3 : 1,
    startUnixMs: startUnixMs + trace * 60_000 + offset,
    endUnixMs: startUnixMs + trace * 60_000 + offset + duration,
    attributes: { ...(operation ? { "gen_ai.operation.name": operation } : {}), ...attributes },
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "typed-steps-fixture" },
    scopeName: "typed-steps-fixture",
  });
  const conversation = { "gen_ai.conversation.id": "fixture-growth-conversation" };
  const firstMessages = [{ role: "user", content: "Summarize the sample document." }];
  const secondMessages = [
    ...firstMessages,
    { role: "assistant", content: "The sample describes a fictional project." },
    { role: "user", content: "List its sample milestones." },
  ];
  return {
    ratel: [
      span(1, 1, null, "invoke_agent cluster_intents", "invoke_agent", 0, 3000, {
        "gen_ai.agent.name": "cluster_intents",
      }),
      span(1, 2, 1, "chat claude-sonnet-5-5", "chat", 100, 2400, {
        ...MODEL,
        "gen_ai.agent.name": "fixture-model-client",
      }),
    ],
    bareChat: [span(2, 1, null, "chat", "chat", 0, 1500, MODEL)],
    stema: [
      span(3, 1, null, "chat", "chat", 0, 4000, MODEL),
      span(3, 2, 1, "prepare_response", null, 1600, 2000),
      span(3, 3, 2, "chat", "chat", 1800, 1500, MODEL),
    ],
    vibiz: [
      span(4, 1, null, "invoke_agent growth_agent", "invoke_agent", 0, 6000, {
        ...conversation,
        "gen_ai.agent.name": "growth_agent",
      }),
      span(4, 2, 1, "agent.step", null, 100, 5500, conversation),
      span(4, 3, 2, "memory.read", null, 150, 100, conversation),
      span(4, 4, 2, "chat", "chat", 300, 1000, { ...MODEL, ...conversation }),
      span(4, 5, 2, "invoke_agent researcher", "invoke_agent", 1500, 3000, {
        ...conversation,
        "gen_ai.agent.name": "researcher",
      }),
      span(4, 6, 5, "chat", "chat", 1600, 2000, { ...MODEL, ...conversation }),
      span(4, 7, 2, "memory.write", null, 5000, 100, conversation),
      span(5, 1, null, "invoke_agent growth_agent", "invoke_agent", 0, 3000, {
        ...conversation,
        "gen_ai.agent.name": "growth_agent",
      }),
      span(5, 2, 1, "chat", "chat", 100, 2000, { ...MODEL, ...conversation }),
    ],
    cato: [
      span(6, 1, null, "invoke_agent chat", "invoke_agent", 0, 5000),
      span(6, 2, 1, "chat", "chat", 100, 1000, {
        ...MODEL,
        "gen_ai.conversation.id": "fixture-flat-conversation",
      }),
      span(6, 3, 1, "execute_tool lookup_sample", "execute_tool", 1500, 200, {
        "gen_ai.tool.name": "lookup_sample",
        "gen_ai.conversation.id": "fixture-flat-conversation",
      }),
      span(6, 4, 1, "chat", "chat", 2000, 1000, {
        ...MODEL,
        "gen_ai.conversation.id": "fixture-flat-conversation",
      }),
    ],
    docs: [
      span(7, 1, null, "ask_sample", null, 0, 6000),
      span(7, 2, 1, "step 1", null, 100, 2000, {
        "ai.prompt.messages": JSON.stringify(firstMessages),
      }),
      span(7, 3, 2, "chat", "chat", 200, 1500, {
        ...MODEL,
        "ai.prompt.messages": JSON.stringify(firstMessages),
      }),
      span(7, 4, 1, "step 2", null, 3000, 2000, {
        "ai.prompt.messages": JSON.stringify(secondMessages),
      }),
      span(7, 5, 4, "chat", "chat", 3100, 1500, {
        ...MODEL,
        "ai.prompt.messages": JSON.stringify(secondMessages),
      }),
    ],
  };
}

/** Encode fixtures for the local OTLP JSON endpoint. */
export function typedStepsRequest(spans: readonly DecodedSpan[]): IExportTraceServiceRequest {
  return {
    resourceSpans: spans.map((span) => ({
      resource: { attributes: wireAttributes(span.resourceAttributes) },
      scopeSpans: [
        {
          scope: { name: span.scopeName ?? "typed-steps-fixture" },
          spans: [
            {
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: (BigInt(span.startUnixMs) * BigInt(1_000_000)).toString(),
              endTimeUnixNano: (BigInt(span.endUnixMs) * BigInt(1_000_000)).toString(),
              attributes: wireAttributes(span.attributes),
              status: { code: span.statusCode },
            },
          ],
        },
      ],
    })),
  };
}

function wireAttributes(attributes: AttrMap): RawKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === "number"
        ? { doubleValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
  }));
}
