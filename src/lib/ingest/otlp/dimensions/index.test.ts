import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveSpanDimensions,
  NO_CLIENT_FACTS,
  NO_DIMENSIONS,
  namedAgentOf,
  type SpanDimensionsById,
} from "@/lib/ingest/otlp/dimensions";
import { indexSpans } from "../attr-resolve";
import type { AttrMap, DecodedSpan } from "../types";

const TRACE = "a".repeat(32);
const ROOT = "1".repeat(16);
const MID = "2".repeat(16);
const LEAF = "3".repeat(16);

function span(
  spanId: string,
  over: Partial<DecodedSpan> & { attributes?: AttrMap } = {},
): DecodedSpan {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: 0,
    endUnixMs: 1,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "pm-service" },
    scopeName: null,
    ...over,
  };
}

const SPANS = new WeakMap<SpanDimensionsById, DecodedSpan[]>();

function derive(spans: DecodedSpan[]) {
  const dims = deriveSpanDimensions(spans, indexSpans(spans));
  SPANS.set(dims, spans);
  return dims;
}

/** The agent name of the ledger payload: read apart from the dimension map, with its old rules. */
function named(dims: SpanDimensionsById, id: string) {
  const spans = SPANS.get(dims) ?? [];
  const own = spans.find((candidate) => candidate.spanId === id);
  return own ? namedAgentOf(own, indexSpans(spans)) : undefined;
}

test("every span with an id has an entry, and a span with no agent has none", () => {
  const dims = derive([span(ROOT), span(LEAF, { parentSpanId: ROOT })]);
  assert.equal(dims.size, 2);
  assert.equal(named(dims, ROOT), null);
  assert.equal(named(dims, LEAF), null);
});

test("the span's own agent attribute names the agent, in AGENT_KEYS order", () => {
  const dims = derive([
    span(ROOT, {
      attributes: {
        "agent.name": "third",
        "gen_ai.agent.id": "second",
        "gen_ai.agent.name": "first",
      },
    }),
    span(LEAF, { attributes: { "agent.name": "  legacy  " } }),
  ]);
  assert.deepEqual(named(dims, ROOT), { name: "first", source: "attribute" });
  assert.deepEqual(named(dims, LEAF), { name: "legacy", source: "attribute" });
});

test("the nearest ancestor's agent attribute wins over a farther one and over the resource", () => {
  const dims = derive([
    span(ROOT, { attributes: { "gen_ai.agent.name": "supervisor" } }),
    span(MID, { parentSpanId: ROOT, attributes: { "gen_ai.agent.name": "researcher" } }),
    span(LEAF, {
      parentSpanId: MID,
      resourceAttributes: { "gen_ai.agent.name": "resource-agent" },
    }),
  ]);
  assert.deepEqual(named(dims, LEAF), { name: "researcher", source: "attribute" });
});

test("the resource's agent attribute is read when no span up the tree has one", () => {
  const dims = derive([
    span(ROOT, { resourceAttributes: { "gen_ai.agent.name": "resource-agent" } }),
  ]);
  assert.deepEqual(named(dims, ROOT), { name: "resource-agent", source: "attribute" });
});

test("with no agent attribute, the nearest invoke_agent ancestor's span name is the agent", () => {
  const dims = derive([
    span(ROOT, {
      name: "invoke_agent outer",
      attributes: { "gen_ai.operation.name": "invoke_agent" },
    }),
    span(MID, {
      parentSpanId: ROOT,
      name: "invoke_agent inner",
      attributes: { "gen_ai.operation.name": "invoke_agent" },
    }),
    span(LEAF, { parentSpanId: MID }),
  ]);
  assert.deepEqual(named(dims, LEAF), { name: "invoke_agent inner", source: "invoke_agent" });
  assert.deepEqual(named(dims, MID), { name: "invoke_agent outer", source: "invoke_agent" });
  // The span's own invoke_agent operation is not its ancestor.
  assert.deepEqual(named(dims, ROOT), null);
});

test("an agent attribute anywhere up the tree wins over a nearer invoke_agent ancestor", () => {
  const dims = derive([
    span(ROOT, { attributes: { "gen_ai.agent.name": "supervisor" } }),
    span(MID, {
      parentSpanId: ROOT,
      name: "invoke_agent inner",
      attributes: { "gen_ai.operation.name": "invoke_agent" },
    }),
    span(LEAF, { parentSpanId: MID }),
  ]);
  assert.deepEqual(named(dims, LEAF), { name: "supervisor", source: "attribute" });
});

test("an agent name is capped at 256 characters", () => {
  const dims = derive([
    span(ROOT, { name: "n".repeat(300), attributes: { "gen_ai.operation.name": "invoke_agent" } }),
    span(MID, { parentSpanId: ROOT }),
    span(LEAF, { attributes: { "gen_ai.agent.name": "a".repeat(300) } }),
  ]);
  assert.equal(named(dims, MID)?.name.length, 256);
  assert.equal(named(dims, LEAF)?.name.length, 256);
});

test("an ancestor outside the export is not read, and a parent cycle ends", () => {
  const dims = derive([
    span(MID, { parentSpanId: LEAF }),
    span(LEAF, { parentSpanId: MID }),
    span(ROOT, { parentSpanId: "f".repeat(16) }),
  ]);
  assert.equal(named(dims, MID), null);
  assert.equal(named(dims, ROOT), null);
});

test("a span with no id has no entry, and the input is not changed", () => {
  const spans = [span("", { attributes: { "gen_ai.agent.name": "x" } }), span(ROOT)];
  const before = JSON.stringify(spans);
  const dims = derive(spans);
  assert.equal(dims.size, 1);
  assert.equal(JSON.stringify(spans), before);
});

// — Entity keys (RC-772) ————————————————————————————————————————————————

const INVOKE = { "gen_ai.operation.name": "invoke_agent" };
const NO_SERVICE = { resourceAttributes: {} };

function keyOf(dims: ReturnType<typeof derive>, id: string) {
  const d = dims.get(id);
  return d ? { key: d.agentKey, source: d.agentSource } : undefined;
}

function mcpOfSpan(dims: ReturnType<typeof derive>, id: string) {
  const d = dims.get(id);
  return d ? { server: d.mcpServer, source: d.mcpServerSource, role: d.mcpRole } : undefined;
}

test("agent key rule 1: the Ratel SDK field wins over every other rule, with source sdk", () => {
  const dims = derive([
    span(ROOT, { attributes: { "ratel.agent.id": "sdk-agent" } }),
    span(LEAF, { parentSpanId: ROOT, attributes: { "gen_ai.agent.name": "semconv-agent" } }),
  ]);
  assert.deepEqual(keyOf(dims, LEAF), { key: "sdk-agent", source: "sdk" });
});

test("agent key rule 2: gen_ai.agent.name, gen_ai.agent.id and agent.name, with source semconv", () => {
  for (const key of ["gen_ai.agent.name", "gen_ai.agent.id", "agent.name"]) {
    const dims = derive([
      span(ROOT, { name: "invoke_agent other", attributes: { ...INVOKE, [key]: "planner" } }),
      span(LEAF, { parentSpanId: ROOT }),
    ]);
    assert.deepEqual(keyOf(dims, LEAF), { key: "planner", source: "semconv" }, key);
  }
});

test("agent key rule 3: a framework's agent span, before an invoke_agent ancestor", () => {
  const traceloop = derive([
    span(ROOT, { name: "invoke_agent outer", attributes: INVOKE }),
    span(MID, {
      parentSpanId: ROOT,
      attributes: { "traceloop.span.kind": "agent", "traceloop.entity.name": "crew-writer" },
    }),
    span(LEAF, { parentSpanId: MID }),
  ]);
  assert.deepEqual(keyOf(traceloop, LEAF), { key: "crew-writer", source: "semconv" });
  const openinference = derive([
    span(ROOT, { name: "ResearchAgent", attributes: { "openinference.span.kind": "AGENT" } }),
    span(LEAF, { parentSpanId: ROOT }),
  ]);
  assert.deepEqual(keyOf(openinference, LEAF), { key: "ResearchAgent", source: "heuristic" });
  assert.deepEqual(keyOf(openinference, ROOT), { key: "ResearchAgent", source: "heuristic" });
});

test("agent key rule 4: the nearest invoke_agent span names the agent without the operation, source heuristic", () => {
  const dims = derive([
    span(ROOT, { name: "invoke_agent outer", attributes: INVOKE }),
    span(MID, { parentSpanId: ROOT, name: "invoke_agent inner", attributes: INVOKE }),
    span(LEAF, { parentSpanId: MID }),
  ]);
  assert.deepEqual(keyOf(dims, LEAF), { key: "inner", source: "heuristic" });
  // The agent span is its own agent's span.
  assert.deepEqual(keyOf(dims, MID), { key: "inner", source: "heuristic" });
  assert.deepEqual(keyOf(dims, ROOT), { key: "outer", source: "heuristic" });
  // The ledger payload keeps the full span name, as before.
  assert.deepEqual(named(dims, LEAF), { name: "invoke_agent inner", source: "invoke_agent" });
});

test("agent key rule 5: with no agent attribute, service.name is the key, source heuristic", () => {
  const dims = derive([span(ROOT), span(LEAF, { parentSpanId: ROOT })]);
  assert.deepEqual(keyOf(dims, ROOT), { key: "pm-service", source: "heuristic" });
  assert.deepEqual(keyOf(dims, LEAF), { key: "pm-service", source: "heuristic" });
  assert.equal(named(dims, LEAF), null, "the ledger payload still names no agent");
  // A bare `invoke_agent` span names nothing, so the service is the agent.
  const bare = derive([
    span(ROOT, { name: "invoke_agent", attributes: INVOKE }),
    span(LEAF, { parentSpanId: ROOT }),
  ]);
  assert.deepEqual(keyOf(bare, LEAF), { key: "pm-service", source: "heuristic" });
});

test("unknown_service is never an agent key or an MCP server key", () => {
  for (const service of ["unknown_service", "unknown_service:node", "  "]) {
    const dims = derive([
      span(ROOT, { resourceAttributes: { "service.name": service } }),
      span(MID, {
        attributes: { "gen_ai.agent.name": "unknown_service" },
        resourceAttributes: { "service.name": service },
      }),
      span(LEAF, {
        kind: 2,
        attributes: { "mcp.method.name": "tools/call" },
        resourceAttributes: { "service.name": service },
      }),
    ]);
    assert.deepEqual(keyOf(dims, ROOT), { key: null, source: null }, service);
    assert.deepEqual(keyOf(dims, MID), { key: null, source: null }, service);
    assert.deepEqual(
      mcpOfSpan(dims, LEAF),
      { server: null, source: null, role: "provided" },
      service,
    );
  }
});

test("a span with no agent and no service has no key", () => {
  const dims = derive([span(ROOT, NO_SERVICE)]);
  assert.deepEqual(dims.get(ROOT), NO_DIMENSIONS);
  assert.deepEqual(dims.get(ROOT), {
    agentKey: null,
    agentSource: null,
    callerAgentKey: null,
    mcpServer: null,
    mcpServerSource: null,
    mcpRole: null,
    mcpSessionId: null,
    client: NO_CLIENT_FACTS,
  });
});

test("the caller is the agent of the nearest ancestor under another agent", () => {
  const dims = derive([
    span(ROOT, {
      name: "invoke_agent supervisor",
      attributes: { ...INVOKE, "gen_ai.agent.name": "supervisor" },
    }),
    span(MID, {
      parentSpanId: ROOT,
      name: "invoke_agent researcher",
      attributes: { ...INVOKE, "gen_ai.agent.name": "researcher" },
    }),
    span(LEAF, {
      parentSpanId: MID,
      name: "execute_tool search",
      attributes: { "gen_ai.operation.name": "execute_tool" },
    }),
  ]);
  assert.equal(dims.get(ROOT)?.agentKey, "supervisor");
  assert.equal(dims.get(ROOT)?.callerAgentKey, null);
  assert.equal(dims.get(MID)?.agentKey, "researcher");
  assert.equal(dims.get(MID)?.callerAgentKey, "supervisor");
  assert.equal(dims.get(LEAF)?.agentKey, "researcher");
  assert.equal(dims.get(LEAF)?.callerAgentKey, "supervisor");
});

test("an MCP server span is provided by its service, and the service is not an agent", () => {
  const dims = derive([
    span(ROOT, {
      kind: 2,
      name: "tools/call find_task",
      attributes: { "mcp.method.name": "tools/call" },
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
    span(LEAF, {
      parentSpanId: ROOT,
      name: "db.query",
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
  ]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), {
    server: "tasks-mcp",
    source: "semconv",
    role: "provided",
  });
  assert.deepEqual(keyOf(dims, ROOT), { key: null, source: null });
  // The server's inner work is no MCP call, and has no agent either.
  assert.deepEqual(mcpOfSpan(dims, LEAF), { server: null, source: null, role: null });
  assert.deepEqual(keyOf(dims, LEAF), { key: null, source: null });
});

test("an MCP server span is found by its span name when the method attribute is missing", () => {
  const dims = derive([
    span(ROOT, {
      kind: 2,
      name: "tools/call find_task",
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
  ]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), {
    server: "tasks-mcp",
    source: "semconv",
    role: "provided",
  });
});

test("an MCP server span with no usable service.name takes the server's own name", () => {
  const dims = derive([
    span(ROOT, {
      kind: 2,
      attributes: { "mcp.method.name": "tools/call", "mcp.server.name": "tasks" },
      resourceAttributes: { "service.name": "unknown_service:python" },
    }),
  ]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), { server: "tasks", source: "semconv", role: "provided" });
});

test("a client span consumes the Ratel SDK's upstream server, source sdk", () => {
  const dims = derive([
    span(ROOT, {
      kind: 3,
      name: "execute_tool github__create_issue",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "github__create_issue",
        "ratel.upstream.server": "gh",
      },
    }),
  ]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), { server: "gh", source: "sdk", role: "consumed" });
  assert.deepEqual(
    keyOf(dims, ROOT),
    { key: "pm-service", source: "heuristic" },
    "the client's service is still the agent",
  );
});

test("a tool call consumes the server its tool name carries, source heuristic", () => {
  const tool = (name: string) =>
    mcpOfSpan(
      derive([
        span(ROOT, {
          attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name },
        }),
      ]),
      ROOT,
    );
  assert.deepEqual(tool("github__create_issue"), {
    server: "github",
    source: "heuristic",
    role: "consumed",
  });
  assert.deepEqual(tool("mcp__linear__list_issues"), {
    server: "linear",
    source: "heuristic",
    role: "consumed",
  });
  assert.deepEqual(tool("my_server__do_it"), {
    server: "my_server",
    source: "heuristic",
    role: "consumed",
  });
  assert.deepEqual(tool("find_task"), { server: null, source: null, role: null });
  assert.deepEqual(tool("__init__"), { server: null, source: null, role: null });
});

test("an MCP client span with no server name is consumed, with no server", () => {
  const dims = derive([
    span(ROOT, {
      kind: 3,
      name: "MCP send tools/call find_task",
      attributes: { "mcp.method.name": "tools/call" },
    }),
  ]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), { server: null, source: null, role: "consumed" });
});

test("a span that is no tool call takes no server from its name", () => {
  const dims = derive([span(ROOT, { name: "github__create_issue" })]);
  assert.deepEqual(mcpOfSpan(dims, ROOT), { server: null, source: null, role: null });
});

test("an MCP server span under the caller's spans in one export does not take the caller's agent", () => {
  const dims = derive([
    span(ROOT, {
      name: "invoke_agent researcher",
      attributes: { ...INVOKE, "gen_ai.agent.name": "researcher" },
    }),
    span(MID, {
      parentSpanId: ROOT,
      kind: 2,
      name: "tools/call find_task",
      attributes: { "mcp.method.name": "tools/call" },
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
    span(LEAF, {
      parentSpanId: MID,
      name: "db.query",
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
  ]);
  assert.deepEqual(keyOf(dims, MID), { key: null, source: null });
  assert.deepEqual(keyOf(dims, LEAF), { key: null, source: null });
  assert.deepEqual(mcpOfSpan(dims, MID), {
    server: "tasks-mcp",
    source: "semconv",
    role: "provided",
  });
});

test("an agent that runs inside an MCP server keeps its own key, and its caller is the agent above the server", () => {
  const dims = derive([
    span(ROOT, { attributes: { "gen_ai.agent.name": "researcher" } }),
    span(MID, {
      parentSpanId: ROOT,
      kind: 2,
      attributes: { "mcp.method.name": "tools/call" },
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
    span(LEAF, {
      parentSpanId: MID,
      attributes: { "gen_ai.agent.name": "summarizer" },
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
  ]);
  assert.deepEqual(keyOf(dims, LEAF), { key: "summarizer", source: "semconv" });
  assert.equal(dims.get(LEAF)?.callerAgentKey, "researcher");
});

test("a span's MCP session is its own mcp.session.id, whatever its role (RC-811)", () => {
  const dims = derive([
    span(ROOT, {
      kind: 2,
      attributes: { "mcp.method.name": "tools/call", "mcp.session.id": " sess-1 " },
      resourceAttributes: { "service.name": "tasks-mcp" },
    }),
    span(MID, { parentSpanId: ROOT }),
    span(LEAF, { attributes: { "mcp.session.id": "s".repeat(300) } }),
  ]);
  assert.equal(dims.get(ROOT)?.mcpSessionId, "sess-1");
  assert.equal(dims.get(MID)?.mcpSessionId, null, "a child does not take its parent's session");
  assert.equal(dims.get(LEAF)?.mcpSessionId?.length, 256);
});
