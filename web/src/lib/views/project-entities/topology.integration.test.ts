import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleAgentStore } from "../agents/adapters/drizzle-store";
import { getMcpServer } from "../mcp-servers/queries";
import { readTopology, type Topology } from "./topology";

/**
 * One project: `claude` hands work twice to `Explore` and once to `Plan`;
 * `claude` calls `board` three times (one failed), `Explore` calls `docs` once,
 * and one `docs` call names no agent. `board` records its own side of one call.
 * Outside the read: a call before the window and another project's call.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const WINDOW = { since: new Date(T0), until: new Date(T0 + 3 * DAY) };

type TestDb = NonNullable<Parameters<typeof insertOtelSpans>[2]> &
  Pick<ReturnType<typeof getDb>, "execute">;

test("agents, sub-agents and servers come back with exact counts", async () => {
  const { client, db } = await seeded();
  try {
    const graph = await read(db);
    assert.deepEqual(counts(graph), {
      project: 1,
      "agent:claude": 2,
      "agent:Explore": 2,
      "agent:Plan": 1,
      "mcp:board": 3,
      "mcp:docs": 2,
    });
    assert.deepEqual(edges(graph), {
      "agent:claude > mcp:board": [3, 1],
      "agent:claude > agent:Explore": [2, null],
      "agent:claude > agent:Plan": [1, null],
      "agent:Explore > mcp:docs": [1, 0],
      "project > mcp:docs": [1, 0],
    });
    assert.equal(graph.nodes.find((node) => node.id === "mcp:board")?.failing, true);
  } finally {
    await client.close();
  }
});

test("a hidden agent does not appear and a merged agent counts as its target", async () => {
  const { client, db } = await seeded();
  try {
    await client.exec(`
      insert into agent_overrides (project_id, agent_key, display_name, hidden, merged_into, updated_by) values
        ('${PROJECT_ID}', 'Plan', null, true, null, 'test'),
        ('${PROJECT_ID}', 'Explore', null, false, 'claude', 'test'),
        ('${PROJECT_ID}', 'claude', 'Main agent', false, null, 'test');
    `);
    const graph = await read(db);
    assert.deepEqual(counts(graph), {
      project: 1,
      "agent:claude": 2,
      "mcp:board": 3,
      "mcp:docs": 2,
    });
    assert.deepEqual(edges(graph), {
      "agent:claude > mcp:board": [3, 1],
      "agent:claude > mcp:docs": [1, 0],
      "project > mcp:docs": [1, 0],
    });
    assert.equal(graph.nodes.find((node) => node.id === "agent:claude")?.name, "Main agent");
  } finally {
    await client.close();
  }
});

test("a call only the server recorded comes from its parent's agent", async () => {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(
      PROJECT_ID,
      [
        span(20, 600, 1, { ...provided("own"), parentSpanId: spanId(1) }),
        span(21, 700, 1, { ...provided("own", true), parentSpanId: spanId(4) }),
        span(22, 800, 9, provided("own")),
      ],
      db,
    );
    const graph = await read(db);
    assert.equal(counts(graph)["mcp:own"], 3);
    const own = Object.entries(edges(graph)).filter(([edge]) => edge.endsWith("mcp:own"));
    assert.deepEqual(Object.fromEntries(own), {
      "agent:claude > mcp:own": [1, 0],
      "agent:Explore > mcp:own": [1, 1],
      "project > mcp:own": [1, 0],
    });
    const page = await getMcpServer(
      PROJECT_ID,
      { key: "own", role: "provided" },
      { ...WINDOW, environment: null },
      db,
    );
    assert.deepEqual(
      (page?.agents ?? []).map(({ agent, calls }) => [agent, calls]).sort(),
      [
        ["Explore", 1],
        ["claude", 1],
        [null, 1],
      ].sort(),
      "the same callers as the MCP server's page",
    );
  } finally {
    await client.close();
  }
});

test("a client call with no agent of its own comes from its parent's agent, through the merges", async () => {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(
      PROJECT_ID,
      [span(20, 600, 1, { ...call("split"), parentSpanId: spanId(4) })],
      db,
    );
    assert.deepEqual(edges(await read(db))["agent:Explore > mcp:split"], [1, 0]);
    assert.equal(counts(await read(db)).project, 1, "still only the call with no agent at all");
    await client.exec(`
      insert into agent_overrides (project_id, agent_key, display_name, hidden, merged_into, updated_by)
      values ('${PROJECT_ID}', 'Explore', null, false, 'claude', 'test');
    `);
    assert.deepEqual(edges(await read(db))["agent:claude > mcp:split"], [1, 0]);
  } finally {
    await client.close();
  }
});

test("a call both sides recorded counts once", async () => {
  // Beside the seed's three calls of `claude` to `board`, at 100 and 200 in trace 1.
  const counted = await boardEdges([
    // Under the client's span, at another time: the two clocks differ.
    span(20, 9_000, 1, { ...provided("board"), parentSpanId: spanId(3) }),
    // Under a transport span of the client.
    span(21, 105, 1, { agentKey: "claude", agentSource: "sdk", parentSpanId: spanId(2) }),
    span(22, 110, 1, { ...provided("board"), parentSpanId: spanId(21) }),
  ]);
  assert.deepEqual(counted, { "agent:claude > mcp:board": [3, 1] });
});

test("a server-only call in another trace counts, beside a client call to the same server", async () => {
  assert.deepEqual(await boardEdges([span(20, 100, 9, provided("board"))]), {
    "agent:claude > mcp:board": [3, 1],
    "project > mcp:board": [1, 0],
  });
});

test("two server-only calls beside one matched pair count three", async () => {
  const counted = await serverEdges("solo", [
    span(20, 100, 8, call("solo", "claude")),
    span(21, 110, 8, { ...provided("solo"), parentSpanId: spanId(20) }),
    // Same trace and time as the pair, and another trace.
    span(22, 115, 8, provided("solo")),
    span(23, 120, 9, provided("solo")),
  ]);
  assert.deepEqual(counted, { "agent:claude > mcp:solo": [1, 0], "project > mcp:solo": [2, 0] });
});

test("two calls in one trace count two: at another time, of another tool, of another caller", async () => {
  const client = span(20, 100, 1, call("solo", "claude"));
  const under = (parent: number) => ({ ...provided("solo"), parentSpanId: spanId(parent) });
  assert.deepEqual(await serverEdges("solo", [client, span(21, 700, 1, under(1))]), {
    "agent:claude > mcp:solo": [2, 0],
  });
  assert.deepEqual(
    await serverEdges("solo", [
      client,
      span(21, 110, 1, { ...under(1), name: "tools/call write" }),
    ]),
    { "agent:claude > mcp:solo": [2, 0] },
  );
  assert.deepEqual(await serverEdges("solo", [client, span(21, 110, 1, under(4))]), {
    "agent:claude > mcp:solo": [1, 0],
    "agent:Explore > mcp:solo": [1, 0],
  });
});

test("parallel calls of one tool with no parent link pair one to one", async () => {
  const parallel = [
    span(20, 100, 1, call("solo", "claude")),
    span(21, 101, 1, call("solo", "claude")),
    span(22, 110, 1, provided("solo")),
    span(23, 111, 1, provided("solo", true)),
  ];
  assert.deepEqual(await serverEdges("solo", parallel), { "agent:claude > mcp:solo": [2, 0] });
  assert.deepEqual(await serverEdges("solo", [...parallel, span(24, 112, 1, provided("solo"))]), {
    "agent:claude > mcp:solo": [2, 0],
    "project > mcp:solo": [1, 0],
  });
});

const boardEdges = (spans: NewOtelSpan[]) => serverEdges("board", spans);

/** The seed's edges to one server, with more spans. */
async function serverEdges(server: string, spans: NewOtelSpan[]) {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(PROJECT_ID, spans, db);
    return Object.fromEntries(
      Object.entries(edges(await read(db))).filter(([edge]) => edge.endsWith(`mcp:${server}`)),
    );
  } finally {
    await client.close();
  }
}

function read(db: TestDb): Promise<Topology> {
  return readTopology(PROJECT_ID, WINDOW, { agents: createDrizzleAgentStore(db), db });
}

function counts(graph: Topology): Record<string, number> {
  return Object.fromEntries(graph.nodes.map((node) => [node.id, node.count]));
}

function edges(graph: Topology): Record<string, [number, number | null]> {
  return Object.fromEntries(
    graph.edges.map((edge) => [`${edge.from} > ${edge.to}`, [edge.count, edge.errors]]),
  );
}

// — Seed ———————————————————————————————————————————————————————————————————

const call = (server: string, agentKey?: string, failed = false): Partial<NewOtelSpan> => ({
  name: "execute_tool search",
  spanClass: "tool",
  mcpServer: server,
  mcpRole: "consumed",
  ...(agentKey ? { agentKey, agentSource: "sdk" } : {}),
  ...(failed ? { statusCode: 2 } : {}),
});

const provided = (server: string, failed = false): Partial<NewOtelSpan> => ({
  name: "tools/call search",
  spanClass: "tool",
  mcpServer: server,
  mcpRole: "provided",
  ...(failed ? { statusCode: 2 } : {}),
});

function spanId(index: number): string {
  return index.toString(16).padStart(16, "0");
}

async function seeded(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const invoke = (name: string, caller?: string): Partial<NewOtelSpan> => ({
    name: `invoke_agent ${name}`,
    operationName: "invoke_agent",
    agentKey: name,
    agentSource: "sdk",
    ...(caller ? { callerAgentKey: caller } : {}),
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(1, 0, 1, invoke("claude")),
      span(2, 100, 1, call("board", "claude", true)),
      span(3, 200, 1, call("board", "claude")),
      span(4, 300, 1, invoke("Explore", "claude")),
      span(5, 400, 1, call("docs", "Explore")),
      span(6, 500, 1, invoke("Plan", "claude")),
      span(7, DAY, 2, invoke("claude")),
      span(8, DAY + 100, 2, call("board", "claude")),
      span(9, DAY + 110, 2, provided("board")),
      span(10, DAY + 200, 2, invoke("Explore", "claude")),
      span(11, DAY + 300, 3, call("docs")),
      span(12, -DAY, 4, call("board", "claude")),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [span(13, 0, 5, { projectId: OTHER_PROJECT_ID, ...call("board", "claude") })],
    db,
  );
  return { client, db };
}

function span(
  index: number,
  at: number,
  trace: number,
  overrides: Partial<NewOtelSpan>,
): NewOtelSpan {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    receivedAt: new Date(T0 + at),
    traceId: trace.toString(16).padStart(32, "0"),
    spanId: spanId(index),
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(T0 + at),
    endedAt: new Date(T0 + at + 50),
    durationMs: 50,
    statusCode: 1,
    serviceName: null,
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
}
