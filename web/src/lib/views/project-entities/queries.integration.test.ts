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
  agentDailyRunsQuery,
  agentMcpCallsQuery,
  agentMcpServerCountsQuery,
  agentToolsQuery,
  type EntityWindow,
  getMcpServerDetailExtras,
  listAgentExtras,
  listAgentTools,
  listMcpServerExtras,
  mcpDailyCallsQuery,
  mcpLastErrorsQuery,
  mcpReachQuery,
  mcpRecentErrorsQuery,
  mcpServerId,
  mcpServerP50Query,
  mcpTopErrorsQuery,
} from "./queries";

/**
 * RP-28: the pages' new reads over `otel_spans`. Seeded, in one project, a
 * three-day window:
 * - day 0, trace 1: `claude` runs; it calls `mcp__board__task_update` (failed,
 *   `error.type` "validation") and `mcp__board__task_get` through the MCP server
 *   `board`, and the built-in `Bash`; it hands work to `Explore`, which runs
 *   `Read`.
 * - day 2, trace 2: `claude` runs; `task_update` fails again ("timeout"), and
 *   once more ("validation", the newest); the server `board` records its own
 *   side of one call (`provided`, no agent on the span, its parent is
 *   claude's client span).
 * Outside the reads: a span before the window and another project's span.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const WINDOW: EntityWindow = { since: new Date(T0), until: new Date(T0 + 3 * DAY) };

type TestDb = Parameters<typeof listAgentExtras>[3] &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("runs per day and MCP servers per agent, merged keys read as their target", async () => {
  const { client, db } = await seeded();
  try {
    const extras = await listAgentExtras(PROJECT_ID, WINDOW, new Map(), db);
    assert.deepEqual(Object.fromEntries(extras.daily), { claude: [1, 0, 1], Explore: [1, 0, 0] });
    assert.deepEqual(Object.fromEntries(extras.mcpServers), { claude: 1 });

    const merged = await listAgentExtras(PROJECT_ID, WINDOW, new Map([["Explore", "claude"]]), db);
    assert.deepEqual(Object.fromEntries(merged.daily), { claude: [1, 0, 1] }, "one run per trace");
  } finally {
    await client.close();
  }
});

test("an agent's tools carry their MCP server, the name without its prefix and the newest error text", async () => {
  const { client, db } = await seeded();
  try {
    const tools = await listAgentTools(PROJECT_ID, ["claude"], WINDOW, db);
    assert.deepEqual(
      tools.map(({ tool, server, calls, errors, lastError }) => ({
        tool,
        server,
        calls,
        errors,
        lastError,
      })),
      [
        { tool: "task_update", server: "board", calls: 3, errors: 3, lastError: "validation" },
        { tool: "Bash", server: null, calls: 1, errors: 0, lastError: null },
        { tool: "task_get", server: "board", calls: 1, errors: 0, lastError: null },
      ],
    );
    assert.deepEqual(
      (await listAgentTools(PROJECT_ID, ["Explore"], WINDOW, db)).map((row) => row.tool),
      ["Read"],
    );
  } finally {
    await client.close();
  }
});

test("each server side has calls per day, its tools and agents busiest first, and its newest error", async () => {
  const { client, db } = await seeded();
  try {
    const extras = await listMcpServerExtras(PROJECT_ID, WINDOW, db);
    assert.deepEqual([...extras.keys()].sort(), [
      mcpServerId("board", "consumed"),
      mcpServerId("board", "provided"),
    ]);
    assert.deepEqual(extras.get(mcpServerId("board", "consumed")), {
      daily: [2, 0, 2],
      tools: ["task_update", "task_get"],
      agents: ["claude"],
      lastError: { tool: "task_update", message: "validation" },
    });
    assert.deepEqual(
      extras.get(mcpServerId("board", "provided")),
      {
        daily: [0, 0, 1],
        tools: ["task_update"],
        agents: ["claude"],
        lastError: null,
      },
      "the server's own span names no agent: its parent, claude's client span, does",
    );
  } finally {
    await client.close();
  }
});

test("the detail's p50, the top error per tool with its count, the callers, and the newest failed calls", async () => {
  const { client, db } = await seeded();
  try {
    const errors = await getMcpServerDetailExtras(
      PROJECT_ID,
      { key: "board", role: "consumed" },
      WINDOW,
      db,
    );
    assert.equal(errors.p50Ms, 50);
    assert.deepEqual(Object.fromEntries(errors.tools), {
      task_update: { topError: { message: "validation", count: 2 }, callers: ["claude"] },
      task_get: { topError: null, callers: ["claude"] },
    });
    assert.deepEqual(
      errors.recent.map(({ tool, message, agent, at, traceId }) => ({
        tool,
        message,
        agent,
        at,
        traceId,
      })),
      [
        {
          tool: "task_update",
          message: "validation",
          agent: "claude",
          at: new Date(T0 + 2 * DAY + 300),
          traceId: traceId(2),
        },
        {
          tool: "task_update",
          message: "timeout",
          agent: "claude",
          at: new Date(T0 + 2 * DAY + 200),
          traceId: traceId(2),
        },
        {
          tool: "task_update",
          message: "validation",
          agent: "claude",
          at: new Date(T0 + 100),
          traceId: traceId(1),
        },
      ],
    );
  } finally {
    await client.close();
  }
});

test("the environment narrows the reads to that environment's calls and traces", async () => {
  const { client, db } = await seeded();
  try {
    const staging = { ...WINDOW, environment: "staging" };
    const extras = await listMcpServerExtras(PROJECT_ID, staging, db);
    assert.deepEqual(extras.get(mcpServerId("board", "consumed"))?.daily, [0, 0, 2]);
    const agents = await listAgentExtras(PROJECT_ID, staging, new Map(), db);
    assert.deepEqual(Object.fromEntries(agents.daily), { claude: [0, 0, 1] });
  } finally {
    await client.close();
  }
});

test("read budget: every query reads otel_spans through an entity index, bounded by project and window", async () => {
  const { client, db } = await seeded();
  try {
    const filler = Array.from({ length: 4_000 }, (_, index) =>
      span(1_000 + index, { at: index * 10 }),
    );
    for (let start = 0; start < filler.length; start += 500)
      await insertOtelSpans(PROJECT_ID, filler.slice(start, start + 500), db);
    await client.exec("analyze otel_spans;");
    const ref = { key: "board", role: "consumed" } as const;
    const queries: Record<string, SQL> = {
      agentDaily: agentDailyRunsQuery(PROJECT_ID, WINDOW, new Map([["Explore", "claude"]])),
      agentServers: agentMcpServerCountsQuery(PROJECT_ID, WINDOW),
      agentTools: agentToolsQuery(PROJECT_ID, ["claude"], WINDOW),
      mcpCallsByAgent: agentMcpCallsQuery(PROJECT_ID, WINDOW, new Map([["Explore", "claude"]])),
      mcpDaily: mcpDailyCallsQuery(PROJECT_ID, WINDOW),
      mcpReach: mcpReachQuery(PROJECT_ID, WINDOW),
      mcpReachOne: mcpReachQuery(PROJECT_ID, WINDOW, ref),
      mcpLastErrors: mcpLastErrorsQuery(PROJECT_ID, WINDOW),
      mcpTopErrors: mcpTopErrorsQuery(PROJECT_ID, ref, WINDOW),
      mcpRecent: mcpRecentErrorsQuery(PROJECT_ID, ref, WINDOW),
      mcpP50: mcpServerP50Query(PROJECT_ID, ref, WINDOW),
    };
    for (const [name, query] of Object.entries(queries)) {
      const plan = await explain(client, query);
      assert.match(
        plan,
        name.startsWith("agent")
          ? /otel_spans_project_(agent_key|mcp_server)_started_idx/
          : /otel_spans_project_mcp_server_started_idx/,
        `${name} reads a partial entity index`,
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
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, environment, spans_max_received_at) values
      ('${PROJECT_ID}', '${traceId(1)}', '${new Date(T0).toISOString()}', 1000, true, 0, 0, 0, 'prod', now()),
      ('${PROJECT_ID}', '${traceId(2)}', '${new Date(T0 + 2 * DAY).toISOString()}', 1000, true, 0, 0, 0, 'staging', now());
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const claude = { agentKey: "claude", agentSource: "sdk" } as const;
  const explore = { agentKey: "Explore", agentSource: "sdk", callerAgentKey: "claude" } as const;
  const tool = (name: string, extra: Partial<NewOtelSpan> = {}): Partial<NewOtelSpan> => ({
    name: `execute_tool ${name}`,
    spanClass: "tool",
    operationName: "execute_tool",
    ...extra,
    attributes: { "gen_ai.tool.name": name, ...(extra.attributes ?? {}) },
  });
  const board = (name: string, environment: string, error?: string): Partial<NewOtelSpan> =>
    tool(`mcp__board__${name}`, {
      mcpServer: "board",
      mcpRole: "consumed",
      ...(error ? { statusCode: 2 } : {}),
      attributes: {
        "deployment.environment.name": environment,
        ...(error ? { "error.type": error } : {}),
      },
    });
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Day 0, trace 1 (prod).
      span(1, {
        at: 0,
        traceId: traceId(1),
        ...claude,
        name: "invoke_agent claude",
        operationName: "invoke_agent",
      }),
      span(2, {
        at: 100,
        traceId: traceId(1),
        ...claude,
        ...board("task_update", "prod", "validation"),
      }),
      span(3, { at: 200, traceId: traceId(1), ...claude, ...board("task_get", "prod") }),
      span(4, { at: 300, traceId: traceId(1), ...claude, ...tool("Bash") }),
      span(5, {
        at: 400,
        traceId: traceId(1),
        ...explore,
        name: "invoke_agent Explore",
        operationName: "invoke_agent",
      }),
      span(6, { at: 500, traceId: traceId(1), ...explore, ...tool("Read") }),
      // Day 2, trace 2 (staging).
      span(7, {
        at: 2 * DAY,
        traceId: traceId(2),
        ...claude,
        name: "invoke_agent claude",
        operationName: "invoke_agent",
      }),
      span(8, {
        at: 2 * DAY + 200,
        traceId: traceId(2),
        ...claude,
        ...board("task_update", "staging", "timeout"),
      }),
      span(9, {
        at: 2 * DAY + 300,
        traceId: traceId(2),
        ...claude,
        ...board("task_update", "staging", "validation"),
      }),
      // The server's own side of span 9's call: no agent, its parent is span 9.
      span(10, {
        at: 2 * DAY + 310,
        traceId: traceId(2),
        parentSpanId: spanId(9),
        name: "tools/call task_update",
        spanClass: "tool",
        mcpServer: "board",
        mcpRole: "provided",
        attributes: { "deployment.environment.name": "staging" },
      }),
      // Outside: before the window.
      span(11, {
        at: -DAY,
        traceId: traceId(3),
        ...claude,
        ...board("task_update", "prod", "old"),
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span(12, {
        at: 100,
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(4),
        ...claude,
        ...board("task_update", "prod", "other"),
      }),
    ],
    db,
  );
  return { client, db };
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function spanId(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, durationMs = 50, ...rest } = overrides;
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
