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

// AOBS-5: a coding agent's tool spans carry masked arguments (JSON) and a masked result (plain text).
test("a tool span's plain-text result is shown as text, not dropped", () => {
  const view = buildTraceContentView([
    {
      spanId: "span-bash",
      name: "execute_tool Bash:git",
      spanClass: "tool",
      durationMs: 40,
      statusCode: 1,
      attributes: {
        "gen_ai.tool.name": "Bash:git",
        "gen_ai.tool.call.id": "toolu_1",
        "gen_ai.tool.call.arguments": JSON.stringify({ command: "git status" }),
        "gen_ai.tool.call.result": "On branch main\nnothing to commit",
      },
    },
  ]);
  assert.deepEqual(view.toolCalls[0]?.arguments, { command: "git status" });
  assert.equal(view.toolCalls[0]?.result, "On branch main\nnothing to commit");
  assert.equal(view.contentCaptured, true);
});

test("tool content on the spans joins the payload's messages instead of replacing them", async () => {
  const { preferSpanContent } = await import("./content-view");
  const spans = buildTraceContentView([
    {
      spanId: "span-bash",
      name: "execute_tool Bash:git",
      spanClass: "tool",
      durationMs: 40,
      statusCode: 2,
      attributes: {
        "gen_ai.tool.name": "Bash:git",
        "gen_ai.tool.call.id": "toolu_1",
        "gen_ai.tool.call.arguments": JSON.stringify({ command: "git status" }),
        "gen_ai.tool.call.result": "fatal: not a git repository",
      },
    },
    {
      spanId: "span-read",
      name: "execute_tool Read",
      spanClass: "tool",
      durationMs: 5,
      statusCode: 1,
      attributes: {
        "gen_ai.tool.name": "Read",
        "gen_ai.tool.call.id": "toolu_2",
        "gen_ai.tool.call.result": "file text",
      },
    },
  ]);
  const payload = {
    messages: [
      { id: "c1:0", role: "user" as const, text: "What changed?" },
      { id: "c1:1", role: "assistant" as const, text: "Nothing changed." },
    ],
    // The payload names the call and has no arguments or result for it.
    toolCalls: [
      {
        id: "toolu_1",
        name: "Bash",
        arguments: {},
        result: null,
        spanId: "c1",
        durationMs: 900,
        statusCode: 0,
      },
    ],
    contentCaptured: true,
  };
  const merged = preferSpanContent(spans, payload);
  assert.deepEqual(
    merged.messages.map((message) => message.text),
    ["What changed?", "Nothing changed."],
  );
  assert.deepEqual(
    merged.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result: call.result,
      spanId: call.spanId,
      statusCode: call.statusCode,
    })),
    [
      {
        id: "toolu_1",
        name: "Bash:git",
        arguments: { command: "git status" },
        result: "fatal: not a git repository",
        spanId: "span-bash",
        statusCode: 2,
      },
      {
        id: "toolu_2",
        name: "Read",
        arguments: null,
        result: "file text",
        spanId: "span-read",
        statusCode: 1,
      },
    ],
  );
  assert.equal(merged.contentCaptured, true);
});

test("spans that carry their own messages still win over the payload", async () => {
  const { preferSpanContent } = await import("./content-view");
  const spans = {
    messages: [{ id: "s:0", role: "user" as const, text: "From the span" }],
    toolCalls: [],
    contentCaptured: true,
  };
  const payload = {
    messages: [{ id: "p:0", role: "user" as const, text: "From the payload" }],
    toolCalls: [],
    contentCaptured: true,
  };
  assert.equal(preferSpanContent(spans, payload), spans);
  assert.equal(
    preferSpanContent({ messages: [], toolCalls: [], contentCaptured: false }, payload),
    payload,
  );
});

test("a tool span without a call id joins the payload call of the same tool, once", async () => {
  const { preferSpanContent } = await import("./content-view");
  const toolSpan = (spanId: string, result: string, callId?: string) => ({
    spanId,
    name: "execute_tool Bash:git",
    spanClass: "tool",
    durationMs: 10,
    statusCode: 1,
    attributes: {
      "gen_ai.tool.name": "Bash:git",
      "gen_ai.tool.call.result": result,
      ...(callId ? { "gen_ai.tool.call.id": callId } : {}),
    },
  });
  const payloadCall = (id: string) => ({
    id,
    name: "Bash",
    arguments: { command: "git status" },
    result: null,
    spanId: "c1",
    durationMs: 0,
    statusCode: 0,
  });
  const payload = {
    messages: [{ id: "c1:0", role: "user" as const, text: "Hi" }],
    toolCalls: [payloadCall("toolu_1"), payloadCall("toolu_2")],
    contentCaptured: true,
  };

  const noIds = preferSpanContent(
    buildTraceContentView([toolSpan("span-a", "first"), toolSpan("span-b", "second")]),
    payload,
  );
  assert.deepEqual(
    noIds.toolCalls.map((call) => [call.id, call.result]),
    [
      ["toolu_1", "first"],
      ["toolu_2", "second"],
    ],
  );

  // Two spans with one call id: the payload call takes the first, the other stays listed.
  const sameId = preferSpanContent(
    buildTraceContentView([
      toolSpan("span-a", "first", "toolu_1"),
      toolSpan("span-b", "second", "toolu_1"),
    ]),
    payload,
  );
  assert.deepEqual(
    sameId.toolCalls.map((call) => [call.id, call.result]),
    [
      ["toolu_1", "first"],
      ["toolu_2", null],
      ["toolu_1", "second"],
    ],
  );
});
