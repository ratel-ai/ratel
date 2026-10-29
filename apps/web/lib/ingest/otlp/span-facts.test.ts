import assert from "node:assert/strict";
import { test } from "node:test";
import { isModelRoundTrip, toolMenuOf } from "./span-facts";
import type { AttrMap, DecodedSpan } from "./types";

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

function span(name: string, attributes: AttrMap): DecodedSpan {
  return {
    traceId: "b".repeat(32),
    spanId: "1".repeat(16),
    parentSpanId: null,
    name,
    kind: 3,
    startUnixMs: T0,
    endUnixMs: T0 + 900,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
  };
}

test("model round trips in each dialect; tools, agents and embeddings are not", () => {
  assert.equal(isModelRoundTrip(span("chat m", { "gen_ai.operation.name": "chat" })), true);
  assert.equal(isModelRoundTrip(span("llm", { "openinference.span.kind": "LLM" })), true);
  assert.equal(isModelRoundTrip(span("llm", { "langsmith.span.kind": "llm" })), true);
  assert.equal(isModelRoundTrip(span("x", { "gen_ai.usage.input_tokens": 10 })), true);
  assert.equal(
    isModelRoundTrip(span("embeddings m", { "gen_ai.operation.name": "embeddings" })),
    false,
  );
  assert.equal(
    isModelRoundTrip(span("execute_tool t", { "gen_ai.operation.name": "execute_tool" })),
    false,
  );
  assert.equal(
    isModelRoundTrip(span("invoke_agent a", { "gen_ai.operation.name": "invoke_agent" })),
    false,
  );
});

test("the tool menu reads gen_ai definitions, OpenInference and AI SDK shapes, names only", () => {
  const genai = JSON.stringify([
    { type: "function", name: "find_task", description: "secret desc", parameters: {} },
    { type: "function", function: { name: "assign_task" } },
    { type: "function", name: "find_task" },
  ]);
  assert.deepEqual(toolMenuOf(span("chat", { "gen_ai.tool.definitions": genai })), [
    "assign_task",
    "find_task",
  ]);
  assert.deepEqual(
    toolMenuOf(
      span("llm", {
        "llm.tools.0.tool.json_schema": '{"type":"function","function":{"name":"b_tool"}}',
        "llm.tools.1.tool.json_schema": '{"name":"a_tool"}',
      }),
    ),
    ["a_tool", "b_tool"],
  );
  assert.deepEqual(
    toolMenuOf(span("ai", { "ai.prompt.tools": ['{"type":"function","name":"x"}'] })),
    ["x"],
  );
  assert.equal(toolMenuOf(span("chat", { "gen_ai.operation.name": "chat" })), null);
});
