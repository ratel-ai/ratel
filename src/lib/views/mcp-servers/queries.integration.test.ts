import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  getMcpServer,
  hasMcpSpans,
  hasMcpSpansQuery,
  listMcpServers,
  type McpServerWindow,
  mcpAgentsQuery,
  mcpEnvironmentsQuery,
  mcpFacetsQuery,
  mcpServerStatsQuery,
  mcpToolsQuery,
  projectsWithMcpSpans,
} from "./queries";

/**
 * RC-777: the MCP servers page reads `otel_spans` by its entity dimensions
 * (RC-772). Seeded, in one project:
 * - `docs-mcp`, provided (the server's own spans): tools `search` (3 calls)
 *   and `fetch` (1), sessions sess-1 (2 calls), sess-2 and one call with no
 *   session; one call failed by status and two by `error.type`; prod 3,
 *   staging 1. Its callers' client spans (another export) name the agents.
 * - `github`, consumed (the agent's tool spans, `github__*` names): agent
 *   `triage` 2 calls, `planner` 1.
 * Outside the reads: a span before the window, another project's span and a
 * span with no MCP server.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const WINDOW: McpServerWindow = {
  since: new Date(T0 - 3_600_000),
  until: new Date(T0 + 3_600_000),
};

type TestDb = NonNullable<Parameters<typeof listMcpServers>[2]> &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("the list has one row per server and role, with calls, errors, p95, sessions and first and last seen", async () => {
  const { client, db } = await seeded();
  try {
    const { servers, environments } = await listMcpServers(PROJECT_ID, WINDOW, db);
    assert.deepEqual(servers, [
      {
        key: "docs-mcp",
        role: "provided",
        displayName: "docs-mcp",
        version: "1.2.0",
        calls: 4,
        errors: 3,
        errorRate: 0.75,
        p95Ms: 370,
        sessions: 3,
        firstSeenAt: new Date(T0),
        lastSeenAt: new Date(T0 + 3_000),
        detection: { source: "semconv", rule: null },
      },
      {
        key: "github",
        role: "consumed",
        displayName: "github",
        version: null,
        calls: 3,
        errors: 0,
        errorRate: 0,
        p95Ms: 58,
        sessions: 2,
        firstSeenAt: new Date(T0 + 10_000),
        lastSeenAt: new Date(T0 + 12_000),
        detection: { source: "heuristic", rule: "tool-prefix" },
      },
    ]);
    assert.deepEqual(environments, ["prod", "staging"]);
  } finally {
    await client.close();
  }
});

test("the environment filter narrows the stats, and the environments stay all of them", async () => {
  const { client, db } = await seeded();
  try {
    const { servers, environments } = await listMcpServers(
      PROJECT_ID,
      { ...WINDOW, environment: "staging" },
      db,
    );
    assert.deepEqual(
      servers.map(({ key, role, calls, errors }) => ({ key, role, calls, errors })),
      [{ key: "docs-mcp", role: "provided", calls: 1, errors: 1 }],
    );
    assert.deepEqual(environments, ["prod", "staging"]);
  } finally {
    await client.close();
  }
});

test("the detail has per-tool stats and the calling agents, and no protocol or transport when no span names one", async () => {
  const { client, db } = await seeded();
  try {
    const detail = await getMcpServer(PROJECT_ID, { key: "docs-mcp" }, WINDOW, db);
    assert.ok(detail);
    assert.equal(detail.server.role, "provided");
    assert.deepEqual(detail.roles, ["provided"]);
    assert.deepEqual(detail.tools, [
      { tool: "search", calls: 3, errors: 2, errorRate: 2 / 3, p50Ms: 200, p95Ms: 380 },
      { tool: "fetch", calls: 1, errors: 1, errorRate: 1, p50Ms: 100, p95Ms: 100 },
    ]);
    // The server's spans carry no agent: its caller's client span (the parent) does.
    assert.deepEqual(detail.agents, [
      { agent: "researcher", calls: 3 },
      { agent: null, calls: 1 },
    ]);
    assert.equal("protocolVersions" in detail, false);
    assert.equal("transports" in detail, false);
  } finally {
    await client.close();
  }
});

test("the detail lists the protocol versions and transports ingest derived (RC-773)", async () => {
  const { client, db } = await seeded();
  try {
    await client.exec(`
      update otel_spans set mcp_protocol_version = '2025-06-18', mcp_transport = 'http'
      where project_id = '${PROJECT_ID}' and mcp_server = 'docs-mcp' and span_id in ('${spanId(1)}', '${spanId(2)}');
      update otel_spans set mcp_protocol_version = '2025-03-26', mcp_transport = 'stdio'
      where project_id = '${PROJECT_ID}' and span_id = '${spanId(3)}';
    `);
    const detail = await getMcpServer(PROJECT_ID, { key: "docs-mcp" }, WINDOW, db);
    assert.deepEqual(detail?.protocolVersions, [
      { value: "2025-06-18", calls: 2 },
      { value: "2025-03-26", calls: 1 },
    ]);
    assert.deepEqual(detail?.transports, [
      { value: "http", calls: 2 },
      { value: "stdio", calls: 1 },
    ]);
  } finally {
    await client.close();
  }
});

test("a consumed server's tools lose the server prefix, and its agents are the agents that call it", async () => {
  const { client, db } = await seeded();
  try {
    const detail = await getMcpServer(PROJECT_ID, { key: "github", role: "consumed" }, WINDOW, db);
    assert.deepEqual(
      detail?.tools.map(({ tool, calls }) => ({ tool, calls })),
      [
        { tool: "create_issue", calls: 2 },
        { tool: "list_prs", calls: 1 },
      ],
    );
    assert.deepEqual(detail?.agents, [
      { agent: "triage", calls: 2 },
      { agent: "planner", calls: 1 },
    ]);
  } finally {
    await client.close();
  }
});

test("the detail picks the server's busiest role when none is asked, and is null for a server with no calls", async () => {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(
      PROJECT_ID,
      [
        span(40, {
          at: 20_000,
          mcpServer: "docs-mcp",
          mcpRole: "consumed",
          agentKey: "triage",
          attributes: { "gen_ai.tool.name": "docs-mcp__search" },
        }),
      ],
      db,
    );
    const busiest = await getMcpServer(PROJECT_ID, { key: "docs-mcp" }, WINDOW, db);
    assert.equal(busiest?.server.role, "provided");
    assert.deepEqual(busiest?.roles, ["provided", "consumed"]);
    const consumed = await getMcpServer(
      PROJECT_ID,
      { key: "docs-mcp", role: "consumed" },
      WINDOW,
      db,
    );
    assert.deepEqual(
      consumed?.tools.map(({ tool }) => tool),
      ["search"],
    );
    assert.equal(await getMcpServer(PROJECT_ID, { key: "nobody" }, WINDOW, db), null);
    assert.equal(
      await getMcpServer(PROJECT_ID, { key: "github", role: "provided" }, WINDOW, db),
      null,
    );
  } finally {
    await client.close();
  }
});

test("hasMcpSpans is true only for a project with an MCP span in the recent window", async () => {
  const { client, db } = await seeded();
  try {
    const now = new Date(T0 + 86_400_000);
    assert.equal(await hasMcpSpans(PROJECT_ID, db, now), true);
    assert.equal(
      await hasMcpSpans(OTHER_PROJECT_ID, db, now),
      false,
      "its only span names no server",
    );
    assert.equal(
      await hasMcpSpans(PROJECT_ID, db, new Date(T0 + 40 * 86_400_000)),
      false,
      "older than the window",
    );
    assert.deepEqual(await projectsWithMcpSpans([PROJECT_ID, OTHER_PROJECT_ID], db, now), [
      PROJECT_ID,
    ]);
    assert.deepEqual(await projectsWithMcpSpans([], db, now), []);
  } finally {
    await client.close();
  }
});

// — Read budget —————————————————————————————————————————————————————————————

test("read budget: every query reads otel_spans through the MCP server index, bounded by project and window", async () => {
  const { client, db } = await seeded();
  try {
    // A project whose spans are mostly not MCP calls: a full scan would read them all.
    const filler = Array.from({ length: 4_000 }, (_, index) =>
      span(1_000 + index, {
        at: index * 10,
        attributes: { "deployment.environment.name": "prod" },
      }),
    );
    for (let start = 0; start < filler.length; start += 500)
      await insertOtelSpans(PROJECT_ID, filler.slice(start, start + 500), db);
    await client.exec("analyze otel_spans");

    const queries: Record<string, SQL> = {
      stats: mcpServerStatsQuery(PROJECT_ID, WINDOW),
      statsFiltered: mcpServerStatsQuery(
        PROJECT_ID,
        { ...WINDOW, environment: "prod" },
        { key: "docs-mcp", role: "provided" },
      ),
      environments: mcpEnvironmentsQuery(PROJECT_ID, WINDOW),
      tools: mcpToolsQuery(PROJECT_ID, { key: "docs-mcp", role: "provided" }, WINDOW),
      facets: mcpFacetsQuery(PROJECT_ID, { key: "docs-mcp", role: "provided" }, WINDOW),
      agents: mcpAgentsQuery(PROJECT_ID, { key: "docs-mcp", role: "provided" }, WINDOW),
      exists: hasMcpSpansQuery([PROJECT_ID], new Date(T0 + 86_400_000)),
    };
    for (const [name, query] of Object.entries(queries)) {
      const plan = await explain(client, query);
      assert.match(
        plan,
        /otel_spans_project_mcp_server_started_idx/,
        `${name} reads the MCP server index`,
      );
      assert.doesNotMatch(plan, /Seq Scan on otel_spans/, `${name} never scans otel_spans`);
      assert.match(plan, /started_at >=/, `${name} is bounded by the window`);
    }
  } finally {
    await client.close();
  }
});

async function explain(client: PGlite, query: SQL): Promise<string> {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  const { rows } = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, params);
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
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
  const server = (attributes: Record<string, unknown>) => ({
    "service.version": "1.2.0",
    "deployment.environment.name": "prod",
    ...attributes,
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      // docs-mcp's callers: client spans in the agent's export, the server spans' parents.
      span(11, {
        at: -50,
        agentKey: "researcher",
        mcpRole: "consumed",
        kind: 3,
        traceId: traceId(1),
      }),
      span(12, {
        at: 950,
        agentKey: "researcher",
        mcpRole: "consumed",
        kind: 3,
        traceId: traceId(1),
      }),
      span(13, {
        at: 1_950,
        agentKey: "researcher",
        mcpRole: "consumed",
        kind: 3,
        traceId: traceId(2),
      }),
      // docs-mcp, the server's side.
      span(1, {
        at: 0,
        durationMs: 200,
        parentSpanId: spanId(11),
        traceId: traceId(1),
        ...provided("search", "sess-1"),
        attributes: server({ "gen_ai.tool.name": "search" }),
      }),
      span(2, {
        at: 1_000,
        durationMs: 400,
        parentSpanId: spanId(12),
        traceId: traceId(1),
        statusCode: 2,
        ...provided("search", "sess-1"),
        attributes: server({ "gen_ai.tool.name": "search" }),
      }),
      span(3, {
        at: 2_000,
        durationMs: 100,
        parentSpanId: spanId(13),
        traceId: traceId(2),
        ...provided("fetch", "sess-2"),
        attributes: server({ "gen_ai.tool.name": "fetch", "error.type": "tool_error" }),
      }),
      span(4, {
        at: 3_000,
        durationMs: 150,
        traceId: traceId(3),
        ...provided("search", null),
        name: "tools/call search",
        attributes: server({ "deployment.environment.name": "staging", "error.type": "timeout" }),
      }),
      // github, consumed by the agents' tool spans.
      span(21, {
        at: 10_000,
        durationMs: 40,
        traceId: traceId(4),
        mcpServer: "github",
        mcpRole: "consumed",
        mcpServerSource: "heuristic",
        agentKey: "triage",
        callerAgentKey: "supervisor",
        attributes: { "gen_ai.tool.name": "github__create_issue", "service.version": "9.9.9" },
      }),
      span(22, {
        at: 11_000,
        durationMs: 60,
        traceId: traceId(4),
        mcpServer: "github",
        mcpRole: "consumed",
        mcpServerSource: "heuristic",
        agentKey: "triage",
        attributes: { "gen_ai.tool.name": "github__create_issue" },
      }),
      span(23, {
        at: 12_000,
        durationMs: 20,
        traceId: traceId(5),
        mcpServer: "github",
        mcpRole: "consumed",
        mcpServerSource: "heuristic",
        agentKey: "planner",
        attributes: { "gen_ai.tool.name": "mcp__github__list_prs" },
      }),
      // Outside every read: before the window, and no MCP server.
      span(30, {
        at: -7_200_000,
        ...provided("search", "sess-old"),
        attributes: server({ "gen_ai.tool.name": "search" }),
      }),
      span(31, { at: 500, attributes: { "gen_ai.tool.name": "lookup" } }),
    ],
    db,
  );
  await insertOtelSpans(OTHER_PROJECT_ID, [span(50, { at: 0, projectId: OTHER_PROJECT_ID })], db);
  return { client, db };
}

function provided(tool: string, session: string | null): Partial<NewOtelSpan> {
  return {
    name: `tools/call ${tool}`,
    kind: 2,
    mcpServer: "docs-mcp",
    mcpServerSource: "semconv",
    mcpRole: "provided",
    mcpSessionId: session,
    serviceName: "docs-mcp",
  };
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function spanId(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, durationMs = 100, ...rest } = overrides;
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    receivedAt: new Date(T0 + at),
    traceId: traceId(100 + index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(T0 + at),
    endedAt: new Date(T0 + at + durationMs),
    durationMs,
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
    ...rest,
  };
}
