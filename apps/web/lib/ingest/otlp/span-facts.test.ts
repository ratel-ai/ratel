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

// AOBS-5
test("mcpServerOf reads mcp.server.name, else the mcp__server__tool name", async () => {
  const { mcpServerOf, skillNameOf } = await import("./span-facts");
  const base = {
    traceId: "a".repeat(32),
    spanId: "1".repeat(16),
    parentSpanId: null,
    name: "execute_tool x",
    kind: 1,
    startUnixMs: 0,
    endUnixMs: 1,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
  };
  assert.equal(
    mcpServerOf({ ...base, attributes: { "mcp.server.name": " beluga_board " } }, "mcp__other__t"),
    "beluga_board",
  );
  assert.equal(
    mcpServerOf({ ...base, attributes: {} }, "mcp__beluga_board__task_update"),
    "beluga_board",
  );
  assert.equal(mcpServerOf({ ...base, attributes: {} }, "Bash:git"), null);
  assert.equal(mcpServerOf({ ...base, attributes: {} }, "mcp____x"), null);
  assert.equal(
    skillNameOf({ ...base, attributes: { "ratel.skill.name": "pr-review" } }),
    "pr-review",
  );
  assert.equal(skillNameOf({ ...base, attributes: {} }), null);
});
