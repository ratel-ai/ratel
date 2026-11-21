import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import type { TraceContentView } from "@/lib/synthesis/traces/content-view";
import { buildSpanIO } from "./span-io";

const NO_PAYLOAD = null;

test("a tool span with raw content shows its arguments and result", () => {
  const io = buildSpanIO(
    {
      spanId: "t1",
      spanClass: "tool",
      attributes: {
        "gen_ai.tool.call.arguments": '{"q":"weather"}',
        "gen_ai.tool.call.result": '{"temp":21}',
      },
    },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, {
    kind: "tool",
    source: "span",
    arguments: { q: "weather" },
    result: { temp: 21 },
  });
});

test("a model span with raw content splits its messages into input and output", () => {
  const io = buildSpanIO(
    {
      spanId: "m1",
      spanClass: "llm_call",
      attributes: {
        "gen_ai.system_instructions": '[{"type":"text","content":"Be brief."}]',
        "gen_ai.input.messages":
          '[{"role":"user","parts":[{"type":"text","content":"Weather in Rome?"}]}]',
        "gen_ai.output.messages":
          '[{"role":"assistant","parts":[{"type":"text","content":"Let me look."},{"type":"tool_call","id":"c1","name":"search","arguments":{"q":"rome"}}]}]',
      },
    },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, {
    kind: "messages",
    source: "span",
    input: [
      { role: "system", text: "Be brief.", toolCalls: [] },
      { role: "user", text: "Weather in Rome?", toolCalls: [] },
    ],
    output: [
      {
        role: "assistant",
        text: "Let me look.",
        toolCalls: [{ name: "search", arguments: { q: "rome" } }],
      },
    ],
  });
});

test("a model span without content shows its call's payload messages", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [
      { id: "m1:system", role: "system", text: "Be brief." },
      { id: "m1:0", role: "user", text: "Weather in Rome?" },
      { id: "m1:1", role: "assistant", text: "Sunny." },
      { id: "m2:2", role: "user", text: "Thanks" },
    ],
    toolCalls: [],
  };

  const io = buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, payload);

  assert.deepEqual(io, {
    kind: "messages",
    source: "payload",
    input: [
      { role: "system", text: "Be brief.", toolCalls: [] },
      { role: "user", text: "Weather in Rome?", toolCalls: [] },
    ],
    output: [{ role: "assistant", text: "Sunny.", toolCalls: [] }],
  });
});

test("a model call's tool calls from the payload are its output", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [{ id: "m1:0", role: "user", text: "Weather in Rome?" }],
    toolCalls: [
      {
        id: "c1",
        name: "search",
        arguments: { q: "rome" },
        result: null,
        spanId: "m1",
        durationMs: 0,
        statusCode: 0,
      },
      {
        id: "c2",
        name: "other",
        arguments: {},
        result: null,
        spanId: "m2",
        durationMs: 0,
        statusCode: 0,
      },
    ],
  };

  const io = buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, payload);

  assert.deepEqual(io, {
    kind: "messages",
    source: "payload",
    input: [{ role: "user", text: "Weather in Rome?", toolCalls: [] }],
    output: [
      { role: "assistant", text: "", toolCalls: [{ name: "search", arguments: { q: "rome" } }] },
    ],
  });
});

test("a tool span without content takes its call from the payload by tool call id", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [],
    toolCalls: [
      {
        id: "c1",
        name: "search",
        arguments: { q: "rome" },
        result: { temp: 21 },
        spanId: "m1",
        durationMs: 0,
        statusCode: 0,
      },
    ],
  };

  const io = buildSpanIO(
    { spanId: "t1", spanClass: "tool", attributes: { "gen_ai.tool.call.id": "c1" } },
    payload,
  );

  assert.deepEqual(io, {
    kind: "tool",
    source: "payload",
    arguments: { q: "rome" },
    result: { temp: 21 },
  });
});

test("a span with no content anywhere has none", () => {
  assert.deepEqual(
    buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, NO_PAYLOAD),
    { kind: "none" },
  );
  assert.deepEqual(
    buildSpanIO({ spanId: "s1", spanClass: "other", attributes: { foo: "bar" } }, NO_PAYLOAD),
    { kind: "none" },
  );
});

test("a tool result that is not JSON stays text", () => {
  const io = buildSpanIO(
    { spanId: "t1", spanClass: "tool", attributes: { "gen_ai.tool.call.result": "plain text" } },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, { kind: "tool", source: "span", arguments: null, result: "plain text" });
});

// RC-501: Mastra's wrapper steps carry their call's content as `mastra.<kind>.input` / `.output`.
const MASTRA_STEP_INPUT = JSON.stringify([
  { role: "system", content: "You are a project-management assistant." },
  { role: "user", content: "Find the Falcon login bug" },
]);
const MASTRA_STEP_OUTPUT = JSON.stringify({
  text: "",
  toolCalls: [{ toolCallId: "c1", toolName: "search_tasks", args: { query: "Falcon" } }],
});

test("a Mastra agent_step with its raw mastra.model_step input and output shows them as messages", () => {
  const io = buildSpanIO(
    {
      spanId: "s1",
      spanClass: "agent",
      attributes: {
        "mastra.model_step.input": MASTRA_STEP_INPUT,
        "mastra.model_step.output": MASTRA_STEP_OUTPUT,
      },
    },
    NO_PAYLOAD,
  );
  assert.deepEqual(io, {
    kind: "messages",
    source: "span",
    input: [
      { role: "system", text: "You are a project-management assistant.", toolCalls: [] },
      { role: "user", text: "Find the Falcon login bug", toolCalls: [] },
    ],
    output: [
      {
        role: "assistant",
        text: "",
        toolCalls: [{ name: "search_tasks", arguments: { query: "Falcon" } }],
      },
    ],
  });
});

test("a Mastra model_generation reads its { messages } input and its text output", () => {
  const io = buildSpanIO(
    {
      spanId: "g1",
      spanClass: "agent",
      attributes: {
        "mastra.model_generation.input": JSON.stringify({
          messages: [{ role: "user", content: [{ type: "text", text: "Assign it to Ada" }] }],
        }),
        "mastra.model_generation.output": JSON.stringify({ text: "Done.", toolCalls: [] }),
      },
    },
    NO_PAYLOAD,
  );
  assert.equal(io.kind, "messages");
  assert.deepEqual(
    io.kind === "messages" ? [io.input.map((m) => m.text), io.output.map((m) => m.text)] : null,
    [["Assign it to Ada"], ["Done."]],
  );
});

test("a wrapper with no content of its own shows its nearest child model call's messages, with source child", () => {
  const child = {
    spanId: "m1",
    spanClass: "llm_call",
    attributes: {
      "gen_ai.input.messages":
        '[{"role":"user","parts":[{"type":"text","content":"Weather in Rome?"}]}]',
      "gen_ai.output.messages":
        '[{"role":"assistant","parts":[{"type":"text","content":"Sunny."}]}]',
    },
  };
  const tool = { spanId: "t1", spanClass: "tool", attributes: {} };
  const io = buildSpanIO({ spanId: "w1", spanClass: "agent", attributes: {} }, NO_PAYLOAD, [
    tool,
    child,
  ]);
  assert.deepEqual(io, {
    kind: "messages",
    source: "child",
    childSpanId: "m1",
    input: [{ role: "user", text: "Weather in Rome?", toolCalls: [] }],
    output: [{ role: "assistant", text: "Sunny.", toolCalls: [] }],
  });
});

test("a wrapper whose child model call has only payload content shows that, with source child", () => {
  const payload: TraceContentView = {
    messages: [
      { id: "m1:0", role: "user", text: "Hi" },
      { id: "m1:1", role: "assistant", text: "Hello" },
    ],
    toolCalls: [],
    contentCaptured: true,
  };
  const io = buildSpanIO({ spanId: "w1", spanClass: "agent", attributes: {} }, payload, [
    { spanId: "m1", spanClass: "llm_call", attributes: {} },
  ]);
  assert.equal(
    io.kind === "messages" && io.source === "child" ? `child:${io.childSpanId}` : io.kind,
    "child:m1",
  );
});

test("a wrapper with no content and no child call with content shows none; a Mastra execute_tool with no arguments shows none", () => {
  assert.deepEqual(
    buildSpanIO({ spanId: "w1", spanClass: "agent", attributes: {} }, NO_PAYLOAD, [
      { spanId: "m1", spanClass: "llm_call", attributes: {} },
    ]),
    { kind: "none" },
  );
  assert.deepEqual(
    buildSpanIO(
      { spanId: "t1", spanClass: "tool", attributes: { "mastra.span.type": "tool_call" } },
      NO_PAYLOAD,
    ),
    { kind: "none" },
  );
});

test("every agent_step and model_generation of the real Mastra export shows messages of its own", () => {
  const spans = loadFixture("mastra").flatMap((body) => decodeOtlp(body.contentType, body.bytes));
  const wrappers = spans.filter(
    (span) => span.name.startsWith("agent_step") || span.name.startsWith("model_generation"),
  );
  assert.equal(wrappers.length, 14);
  for (const span of wrappers) {
    const io = buildSpanIO(
      { spanId: span.spanId, spanClass: "agent", attributes: span.attributes },
      NO_PAYLOAD,
    );
    assert.ok(
      io.kind === "messages" &&
        io.source === "span" &&
        io.input.some((m) => m.role === "user") &&
        io.output.length > 0,
      span.name,
    );
  }
});

test("an agent step that carries its own ask (an invoke_agent root, RC-740) shows it, not its child's", () => {
  const ask = JSON.stringify([
    { role: "user", parts: [{ type: "text", content: "label_workflows for project p-1" }] },
  ]);
  const io = buildSpanIO(
    {
      spanId: "root",
      spanClass: "other",
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.input.messages": ask },
    },
    NO_PAYLOAD,
    [
      {
        spanId: "m1",
        spanClass: "llm_call",
        attributes: {
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "Name this workflow" }] },
          ]),
        },
      },
    ],
  );
  assert.equal(io.kind, "messages");
  assert.ok(io.kind === "messages" && io.source === "span");
  assert.deepEqual(io.kind === "messages" ? io.input.map((message) => message.text) : [], [
    "label_workflows for project p-1",
  ]);
});

test("an agent step with no messages of its own still shows its first model call's", () => {
  const io = buildSpanIO(
    { spanId: "root", spanClass: "other", attributes: { "gen_ai.operation.name": "invoke_agent" } },
    NO_PAYLOAD,
    [
      {
        spanId: "m1",
        spanClass: "llm_call",
        attributes: {
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "Name this workflow" }] },
          ]),
        },
      },
    ],
  );
  assert.ok(io.kind === "messages" && io.source === "child");
});
