import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveModelCalls, OTLP_MODEL_CALL } from "./derive-model-calls";
import type { AttrMap, DecodedSpan } from "./types";

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

function span(name: string, attributes: AttrMap, over: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "d".repeat(32),
    spanId: "1".repeat(16),
    parentSpanId: null,
    name,
    kind: 3,
    startUnixMs: T0,
    endUnixMs: T0 + 1200,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "pm-agent" },
    scopeName: null,
    ...over,
  };
}

test("a chat span becomes one model-call row with tokens, model and menu names only", () => {
  const [row] = deriveModelCalls([
    span("chat claude", {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-sonnet-5",
      "gen_ai.usage.input_tokens": 1800,
      "gen_ai.usage.output_tokens": 120,
      "gen_ai.conversation.id": "conv-2",
      "gen_ai.tool.definitions": JSON.stringify([{ name: "find_task", description: "not stored" }]),
    }),
  ]);
  assert.equal(row.type, OTLP_MODEL_CALL);
  assert.equal(row.sessionId, "conv-2");
  assert.equal(row.inputTokens, 1800);
  assert.equal(row.outputTokens, 120);
  assert.equal(row.tookMs, 1200);
  assert.deepEqual(row.payload.menu, ["find_task"]);
  assert.equal(row.payload.model, "claude-sonnet-5");
  assert.ok(!JSON.stringify(row).includes("not stored"));
});

test("OpenInference LLM spans count; tools, agents and embeddings do not", () => {
  const rows = deriveModelCalls([
    span("llm", {
      "openinference.span.kind": "LLM",
      "llm.model_name": "gpt-5.5",
      "llm.token_count.prompt": 900,
    }),
    span("execute_tool t", { "gen_ai.operation.name": "execute_tool" }, { spanId: "2".repeat(16) }),
    span("invoke_agent a", { "gen_ai.operation.name": "invoke_agent" }, { spanId: "3".repeat(16) }),
    span(
      "embeddings m",
      { "gen_ai.operation.name": "embeddings", "gen_ai.request.model": "e" },
      { spanId: "4".repeat(16) },
    ),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 900);
  assert.equal(rows[0].payload.model, "gpt-5.5");
});

test("an agent-level span with the run's summed usage is not a model call", () => {
  const rows = deriveModelCalls([
    span("invoke_agent pm-agent", {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1040,
    }),
    span(
      "step 1",
      { "gen_ai.operation.name": "agent_step", "gen_ai.usage.input_tokens": 110 },
      { spanId: "2".repeat(16) },
    ),
  ]);
  assert.equal(rows.length, 0);
});

test("a model span wrapping another model span of the same call counts once, as the inner one", () => {
  const outer = span(
    "generation",
    { "openinference.span.kind": "LLM", "llm.token_count.prompt": 110 },
    { spanId: "a".repeat(16) },
  );
  const inner = span(
    "ChatCompletion",
    {
      "openinference.span.kind": "LLM",
      "llm.token_count.prompt": 110,
      "llm.tools.0.tool.json_schema": JSON.stringify({
        type: "function",
        function: { name: "find_task" },
      }),
    },
    { spanId: "b".repeat(16), parentSpanId: "a".repeat(16) },
  );
  const rows = deriveModelCalls([outer, inner]);
  assert.deepEqual(
    rows.map((r) => r.spanId),
    ["b".repeat(16)],
  );
  assert.deepEqual(rows[0].payload.menu, ["find_task"]);
});

test("the menu and the ask fall back to the agent span around the call (Mastra)", () => {
  const agent = span(
    "invoke_agent pm-agent",
    {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.tool.definitions": JSON.stringify(["search_tasks", "get_task"]),
    },
    { spanId: "a".repeat(16) },
  );
  const step = span(
    "agent_step pm-agent",
    {
      "gen_ai.operation.name": "agent_step",
      "mastra.model_step.input": JSON.stringify([
        { role: "system", content: "Use the tools." },
        { role: "user", content: "Find the Falcon bug" },
      ]),
    },
    { spanId: "b".repeat(16), parentSpanId: "a".repeat(16) },
  );
  const chat = span(
    "chat gpt-4o-mini",
    {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 110,
    },
    { spanId: "c".repeat(16), parentSpanId: "b".repeat(16) },
  );
  const [row] = deriveModelCalls([agent, step, chat]);
  assert.deepEqual(row.payload.menu, ["get_task", "search_tasks"]);
  assert.equal(row.payload.prompt, "Find the Falcon bug");
});

test("a model call records the agent that made it and whether a system started its turn", () => {
  const messages = (text: string) =>
    JSON.stringify([{ role: "user", parts: [{ type: "text", content: text }] }]);
  const [system] = deriveModelCalls([
    span("chat", {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "supervisor",
      "gen_ai.input.messages": messages("Background task t1 (video) is completed."),
    }),
  ]);
  assert.equal(system.payload.started_by, "system");
  assert.equal(system.payload.agent, "supervisor");
  const [person] = deriveModelCalls([
    span("chat", {
      "gen_ai.operation.name": "chat",
      "gen_ai.input.messages": messages("make me a video"),
    }),
  ]);
  assert.equal(
    "started_by" in person.payload,
    false,
    "a person's turn carries its prompt and no system mark",
  );
});
