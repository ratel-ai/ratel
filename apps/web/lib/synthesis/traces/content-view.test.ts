import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceContentView } from "./content-view";

test("trace content view separates captured messages and tool calls", () => {
  const view = buildTraceContentView([
    {
      spanId: "span-chat",
      name: "chat",
      spanClass: "llm_call",
      durationMs: 100,
      statusCode: 1,
      attributes: {
        "gen_ai.system_instructions": "You are concise.",
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "Find the docs" }] },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [
              { type: "text", content: "I will search." },
              {
                type: "tool_call",
                id: "call-1",
                name: "search_docs",
                arguments: { query: "capture content" },
              },
              {
                type: "tool_call_response",
                id: "call-1",
                response: { hits: 3 },
              },
            ],
          },
        ]),
      },
    },
  ]);

  assert.deepEqual(
    view.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "system", text: "You are concise." },
      { role: "user", text: "Find the docs" },
      { role: "assistant", text: "I will search." },
      { role: "tool", text: '{"hits":3}' },
    ],
  );
  assert.deepEqual(view.toolCalls, [
    {
      id: "call-1",
      name: "search_docs",
      arguments: { query: "capture content" },
      result: { hits: 3 },
      spanId: "span-chat",
      durationMs: 100,
      statusCode: 1,
    },
  ]);
  assert.equal(view.contentCaptured, true);
});

test("trace content view keeps metadata-only tool spans honest", () => {
  const view = buildTraceContentView([
    {
      spanId: "span-tool",
      name: "execute_tool",
      spanClass: "tool",
      durationMs: 42,
      statusCode: 0,
      attributes: { "gen_ai.tool.name": "search_docs" },
    },
  ]);

  assert.deepEqual(view.messages, []);
  assert.deepEqual(view.toolCalls, [
    {
      id: "span-tool",
      name: "search_docs",
      arguments: null,
      result: null,
      spanId: "span-tool",
      durationMs: 42,
      statusCode: 0,
    },
  ]);
  assert.equal(view.contentCaptured, false);
});
