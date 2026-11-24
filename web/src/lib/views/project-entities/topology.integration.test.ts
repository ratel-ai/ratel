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
  const call = (server: string, agentKey?: string, failed = false): Partial<NewOtelSpan> => ({
    name: "execute_tool search",
    spanClass: "tool",
    mcpServer: server,
    mcpRole: "consumed",
    ...(agentKey ? { agentKey, agentSource: "sdk" } : {}),
    ...(failed ? { statusCode: 2 } : {}),
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
      span(9, DAY + 110, 2, {
        name: "tools/call search",
        spanClass: "tool",
        mcpServer: "board",
        mcpRole: "provided",
      }),
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
    spanId: index.toString(16).padStart(16, "0"),
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
