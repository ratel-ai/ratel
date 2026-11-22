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
  agentEnvironmentsQuery,
  agentMcpServersQuery,
  agentStatsQuery,
  agentToolsQuery,
  createDrizzleAgentOverrideStore,
  createDrizzleAgentStore,
  handoffsQuery,
  projectsWithAgentsQuery,
} from "../adapters/drizzle-store";
import type { AgentWindow } from "../domain/types";

/**
 * RC-775: the Agents page reads `otel_spans` by `agent_key` and
 * `caller_agent_key` (RC-772). Seeded, in one project:
 * - trace 1 (prod): `supervisor` runs 0..1000 ms and spends $0.01; it invokes
 *   `researcher` (100..600 ms), which calls tool `search` twice and the MCP
 *   server `docs-mcp` once.
 * - trace 2 (staging): `supervisor` runs 0..2000 ms and spends $0.02; it
 *   invokes `researcher` (one failed `search`) and `writer`.
 * Outside the reads: a trace before the window and another project's span.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_ONLY_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ONE_NAMED_PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const TWO_SERVICES_PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const WINDOW: AgentWindow = { since: new Date(T0 - 3_600_000), until: new Date(T0 + 3_600_000) };

type TestDb = Parameters<typeof createDrizzleAgentStore>[0] &
  Parameters<typeof createDrizzleAgentOverrideStore>[0] &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("the list has one row per agent with runs, errors, cost, p95 and first and last seen", async () => {
  const { client, db } = await seeded();
  try {
    const { agents, environments } = await createDrizzleAgentStore(db).listAgents(
      PROJECT_ID,
      WINDOW,
    );
    assert.deepEqual(agents, [
      {
        key: "researcher",
        displayName: "researcher",
        hidden: false,
        mergedKeys: [],
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        costUsd: 0.004,
        p95Ms: 880,
        firstSeenAt: new Date(T0 + 100),
        lastSeenAt: new Date(T0 + 10_400),
        detection: { source: "heuristic", rule: "agent-span-name" },
      },
      {
        key: "supervisor",
        displayName: "supervisor",
        hidden: false,
        mergedKeys: [],
        calls: 2,
        errors: 0,
        errorRate: 0,
        costUsd: 0.03,
        p95Ms: 1950,
        firstSeenAt: new Date(T0),
        lastSeenAt: new Date(T0 + 10_010),
        detection: { source: "semconv", rule: null },
      },
      {
        key: "writer",
        displayName: "writer",
        hidden: false,
        mergedKeys: [],
        calls: 1,
        errors: 0,
        errorRate: 0,
        costUsd: 0,
        p95Ms: 300,
        firstSeenAt: new Date(T0 + 11_000),
        lastSeenAt: new Date(T0 + 11_000),
        detection: { source: "heuristic", rule: "agent-span-name" },
      },
    ]);
    assert.deepEqual(environments, ["prod", "staging"]);
  } finally {
    await client.close();
  }
});

test("an agent reads as its weakest source; a heuristic key from service.name names that rule (RC-779)", async () => {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(
      SERVICE_ONLY_PROJECT_ID,
      [
        span(80, {
          at: 0,
          projectId: SERVICE_ONLY_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "pm-service",
          agentSource: "sdk",
        }),
        span(81, {
          at: 10,
          projectId: SERVICE_ONLY_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "pm-service",
          agentSource: "heuristic",
        }),
        span(82, {
          at: 20,
          projectId: SERVICE_ONLY_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "named",
          agentSource: "sdk",
        }),
        span(83, {
          at: 30,
          projectId: SERVICE_ONLY_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "named",
          agentSource: "semconv",
        }),
      ],
      db,
    );
    const { agents } = await createDrizzleAgentStore(db).listAgents(
      SERVICE_ONLY_PROJECT_ID,
      WINDOW,
    );
    assert.deepEqual(
      agents.map(({ key, detection }) => ({ key, detection })),
      [
        { key: "named", detection: { source: "semconv", rule: null } },
        { key: "pm-service", detection: { source: "heuristic", rule: "service-name" } },
      ],
    );
  } finally {
    await client.close();
  }
});

test("the environment filter narrows the list and the detail to that environment's traces, and the environments stay all of them", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleAgentStore(db);
    const staging = { ...WINDOW, environment: "staging" };
    const { agents, environments } = await store.listAgents(PROJECT_ID, staging);
    assert.deepEqual(
      agents.map(({ key, calls, errors }) => ({ key, calls, errors })),
      [
        { key: "researcher", calls: 1, errors: 1 },
        { key: "supervisor", calls: 1, errors: 0 },
        { key: "writer", calls: 1, errors: 0 },
      ],
    );
    assert.deepEqual(environments, ["prod", "staging"]);
    const detail = await store.getAgent(PROJECT_ID, "researcher", staging);
    assert.deepEqual(
      detail?.tools.map(({ tool, calls }) => ({ tool, calls })),
      [{ tool: "search", calls: 1 }],
    );
    assert.deepEqual(detail?.mcpServers, []);
    assert.deepEqual(await store.listHandoffs(PROJECT_ID, { ...WINDOW, environment: "prod" }), [
      {
        from: "supervisor",
        to: "researcher",
        fromName: "supervisor",
        toName: "researcher",
        count: 1,
      },
    ]);
  } finally {
    await client.close();
  }
});

test("the detail has the agent's tools, the MCP servers it calls, and its handoffs both ways", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleAgentStore(db);
    const researcher = await store.getAgent(PROJECT_ID, "researcher", WINDOW);
    assert.ok(researcher);
    assert.equal(researcher.agent.key, "researcher");
    assert.deepEqual(researcher.tools, [
      { tool: "search", calls: 3, errors: 1, errorRate: 1 / 3, p95Ms: 49 },
    ]);
    assert.deepEqual(researcher.mcpServers, [{ server: "docs-mcp", calls: 1, errors: 0 }]);
    assert.deepEqual(researcher.callers, [
      {
        from: "supervisor",
        to: "researcher",
        fromName: "supervisor",
        toName: "researcher",
        count: 2,
      },
    ]);
    assert.deepEqual(researcher.callees, []);

    const supervisor = await store.getAgent(PROJECT_ID, "supervisor", WINDOW);
    assert.deepEqual(supervisor?.callers, []);
    assert.deepEqual(supervisor?.callees, [
      {
        from: "supervisor",
        to: "researcher",
        fromName: "supervisor",
        toName: "researcher",
        count: 2,
      },
      { from: "supervisor", to: "writer", fromName: "supervisor", toName: "writer", count: 1 },
    ]);
    assert.equal(await store.getAgent(PROJECT_ID, "nobody", WINDOW), null);
  } finally {
    await client.close();
  }
});

test("the handoffs are one edge per caller and callee, counted by invoke_agent spans, else by traces", async () => {
  const { client, db } = await seeded();
  try {
    // A handoff named only by attributes: no invoke_agent span, so it counts traces.
    await insertOtelSpans(
      PROJECT_ID,
      [
        span(60, {
          at: 20_000,
          traceId: traceId(9),
          agentKey: "writer",
          callerAgentKey: "researcher",
        }),
      ],
      db,
    );
    assert.deepEqual(await createDrizzleAgentStore(db).listHandoffs(PROJECT_ID, WINDOW), [
      {
        from: "supervisor",
        to: "researcher",
        fromName: "supervisor",
        toName: "researcher",
        count: 2,
      },
      { from: "researcher", to: "writer", fromName: "researcher", toName: "writer", count: 1 },
      { from: "supervisor", to: "writer", fromName: "supervisor", toName: "writer", count: 1 },
    ]);
  } finally {
    await client.close();
  }
});

test("navigation: a project with 2+ agent keys or 1 named key has agents; one whose only agent is its service.name has none", async () => {
  const { client, db } = await seeded();
  try {
    await insertOtelSpans(
      SERVICE_ONLY_PROJECT_ID,
      [
        span(70, {
          at: 0,
          projectId: SERVICE_ONLY_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "pm-service",
          agentSource: "heuristic",
        }),
      ],
      db,
    );
    await insertOtelSpans(
      ONE_NAMED_PROJECT_ID,
      [
        span(71, {
          at: 0,
          projectId: ONE_NAMED_PROJECT_ID,
          serviceName: "pm-service",
          agentKey: "planner",
          agentSource: "semconv",
        }),
      ],
      db,
    );
    await insertOtelSpans(
      TWO_SERVICES_PROJECT_ID,
      [
        span(72, {
          at: 0,
          projectId: TWO_SERVICES_PROJECT_ID,
          serviceName: "a-service",
          agentKey: "a-service",
          agentSource: "heuristic",
        }),
        span(73, {
          at: 0,
          projectId: TWO_SERVICES_PROJECT_ID,
          serviceName: "b-service",
          agentKey: "b-service",
          agentSource: "heuristic",
        }),
      ],
      db,
    );
    const store = createDrizzleAgentStore(db);
    const all = [
      PROJECT_ID,
      OTHER_PROJECT_ID,
      SERVICE_ONLY_PROJECT_ID,
      ONE_NAMED_PROJECT_ID,
      TWO_SERVICES_PROJECT_ID,
    ];
    const now = new Date(T0 + 86_400_000);
    assert.deepEqual(
      (await store.projectsWithAgents(all, now)).sort(),
      [PROJECT_ID, ONE_NAMED_PROJECT_ID, TWO_SERVICES_PROJECT_ID].sort(),
    );
    assert.deepEqual(
      await store.projectsWithAgents(all, new Date(T0 + 40 * 86_400_000)),
      [],
      "older than the window",
    );
    assert.deepEqual(await store.projectsWithAgents([], now), []);
  } finally {
    await client.close();
  }
});

// — Overrides (RC-776) ——————————————————————————————————————————————————————

test("merge sums both keys' history under the target, in the list, the detail and the handoffs; undo restores both", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleAgentStore(db);
    const overrides = createDrizzleAgentOverrideStore(db);
    assert.deepEqual(
      await overrides.changeOverride(
        PROJECT_ID,
        { agentKey: "writer", mergedInto: "researcher" },
        "user_1",
      ),
      {
        ok: true,
        override: {
          agentKey: "writer",
          displayName: null,
          hidden: false,
          mergedInto: "researcher",
        },
      },
    );

    const { agents } = await store.listAgents(PROJECT_ID, WINDOW);
    assert.deepEqual(
      agents.map(({ key, calls, errors, costUsd, p95Ms, mergedKeys, firstSeenAt, lastSeenAt }) => ({
        key,
        calls,
        errors,
        costUsd,
        p95Ms,
        mergedKeys,
        firstSeenAt,
        lastSeenAt,
      })),
      [
        // Trace 2's researcher and writer spans are one run, 10.1 s to 11.3 s.
        {
          key: "researcher",
          calls: 2,
          errors: 1,
          costUsd: 0.004,
          p95Ms: 1165,
          mergedKeys: ["writer"],
          firstSeenAt: new Date(T0 + 100),
          lastSeenAt: new Date(T0 + 11_000),
        },
        {
          key: "supervisor",
          calls: 2,
          errors: 0,
          costUsd: 0.03,
          p95Ms: 1950,
          mergedKeys: [],
          firstSeenAt: new Date(T0),
          lastSeenAt: new Date(T0 + 10_010),
        },
      ],
    );
    assert.deepEqual(await store.listHandoffs(PROJECT_ID, WINDOW), [
      {
        from: "supervisor",
        to: "researcher",
        fromName: "supervisor",
        toName: "researcher",
        count: 3,
      },
    ]);
    const merged = await store.getAgent(PROJECT_ID, "writer", WINDOW);
    assert.equal(merged?.agent.key, "researcher", "a merged key reads as its target");
    assert.deepEqual(
      merged?.callers.map(({ from, count }) => ({ from, count })),
      [{ from: "supervisor", count: 3 }],
    );

    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from otel_spans where agent_key = 'writer'`,
    );
    assert.equal(rows[0]?.n, 1, "stored spans are not rewritten");

    await overrides.changeOverride(PROJECT_ID, { agentKey: "writer", mergedInto: null }, "user_1");
    assert.deepEqual(
      (await store.listAgents(PROJECT_ID, WINDOW)).agents.map(({ key, calls }) => ({ key, calls })),
      [
        { key: "researcher", calls: 2 },
        { key: "supervisor", calls: 2 },
        { key: "writer", calls: 1 },
      ],
    );
    assert.deepEqual(
      await store.listOverrides(PROJECT_ID),
      [],
      "an override that changes nothing is deleted",
    );
  } finally {
    await client.close();
  }
});

test("rename shows the name on the list, the detail and both ends of a handoff", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleAgentStore(db);
    await createDrizzleAgentOverrideStore(db).changeOverride(
      PROJECT_ID,
      { agentKey: "researcher", displayName: "Research agent" },
      "user_1",
    );
    assert.equal(
      (await store.listAgents(PROJECT_ID, WINDOW)).agents[0]?.displayName,
      "Research agent",
    );
    assert.equal(
      (await store.getAgent(PROJECT_ID, "researcher", WINDOW))?.agent.displayName,
      "Research agent",
    );
    assert.equal((await store.listHandoffs(PROJECT_ID, WINDOW))[0]?.toName, "Research agent");
  } finally {
    await client.close();
  }
});

test("hide removes the agent from the list and the graph, and show hidden brings it back", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleAgentStore(db);
    await createDrizzleAgentOverrideStore(db).changeOverride(
      PROJECT_ID,
      { agentKey: "supervisor", hidden: true },
      "user_1",
    );
    assert.deepEqual(
      (await store.listAgents(PROJECT_ID, WINDOW)).agents.map((row) => row.key),
      ["researcher", "writer"],
    );
    assert.deepEqual(await store.listHandoffs(PROJECT_ID, WINDOW), []);
    const all = await store.listAgents(PROJECT_ID, WINDOW, { showHidden: true });
    assert.deepEqual(
      all.agents.map(({ key, hidden }) => ({ key, hidden })),
      [
        { key: "researcher", hidden: false },
        { key: "supervisor", hidden: true },
        { key: "writer", hidden: false },
      ],
    );
    assert.equal((await store.listHandoffs(PROJECT_ID, WINDOW, { showHidden: true })).length, 2);
  } finally {
    await client.close();
  }
});

test("a merge chain or cycle is rejected and writes nothing", async () => {
  const { client, db } = await seeded();
  try {
    const overrides = createDrizzleAgentOverrideStore(db);
    await overrides.changeOverride(
      PROJECT_ID,
      { agentKey: "writer", mergedInto: "researcher" },
      "user_1",
    );
    assert.deepEqual(
      await overrides.changeOverride(
        PROJECT_ID,
        { agentKey: "supervisor", mergedInto: "writer" },
        "user_1",
      ),
      { ok: false, reason: "merge_target_is_merged" },
    );
    assert.deepEqual(
      await overrides.changeOverride(
        PROJECT_ID,
        { agentKey: "researcher", mergedInto: "supervisor" },
        "user_1",
      ),
      { ok: false, reason: "agent_is_merge_target" },
    );
    assert.deepEqual(
      await overrides.changeOverride(
        PROJECT_ID,
        { agentKey: "researcher", mergedInto: "writer" },
        "user_1",
      ),
      { ok: false, reason: "merge_target_is_merged" },
    );
    assert.deepEqual(
      (await createDrizzleAgentStore(db).listOverrides(PROJECT_ID)).map(
        ({ agentKey, mergedInto }) => [agentKey, mergedInto],
      ),
      [["writer", "researcher"]],
    );
  } finally {
    await client.close();
  }
});

// — Read budget —————————————————————————————————————————————————————————————

test("read budget: every span query reads otel_spans through the agent index, bounded by project and window", async () => {
  const { client, db } = await seeded();
  try {
    // Spans with no agent: a full scan would read them all.
    const filler = Array.from({ length: 4_000 }, (_, index) =>
      span(1_000 + index, { at: index * 10 }),
    );
    for (let start = 0; start < filler.length; start += 500)
      await insertOtelSpans(PROJECT_ID, filler.slice(start, start + 500), db);
    // Their traces' summaries, in prod: the environment alone selects many traces, as in production.
    await client.exec(`
      insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, environment, spans_max_received_at)
      select '${PROJECT_ID}', lpad(to_hex(1100 + i), 32, '0'), '${new Date(T0).toISOString()}'::timestamptz + i * interval '10 milliseconds', 100, false, 0, 0, 0, 'prod', now()
      from generate_series(0, 3999) as i;
      analyze otel_spans; analyze otel_trace_summaries;
    `);

    const prod = { ...WINDOW, environment: "prod" };
    const queries: Record<string, SQL> = {
      stats: agentStatsQuery(PROJECT_ID, WINDOW),
      statsFiltered: agentStatsQuery(PROJECT_ID, prod, { sources: ["researcher"] }),
      statsMerged: agentStatsQuery(PROJECT_ID, WINDOW, {
        merges: new Map([["writer", "researcher"]]),
        sources: ["researcher", "writer"],
      }),
      tools: agentToolsQuery(PROJECT_ID, ["researcher"], prod),
      mcpServers: agentMcpServersQuery(PROJECT_ID, ["researcher"], WINDOW),
      handoffs: handoffsQuery(PROJECT_ID, prod),
      handoffsMerged: handoffsQuery(PROJECT_ID, WINDOW, {
        merges: new Map([["writer", "researcher"]]),
        sources: ["researcher", "writer"],
      }),
      nav: projectsWithAgentsQuery([PROJECT_ID], new Date(T0 + 86_400_000)),
    };
    for (const [name, query] of Object.entries(queries)) {
      const plan = await explain(client, query);
      // The MCP servers read may take the MCP server index: partial and bounded the same way.
      assert.match(
        plan,
        name === "mcpServers"
          ? /otel_spans_project_(agent_key|mcp_server)_started_idx/
          : /otel_spans_project_agent_key_started_idx/,
        `${name} reads a partial entity index`,
      );
      assert.doesNotMatch(plan, /Seq Scan on otel_spans/, `${name} never scans otel_spans`);
      assert.match(plan, /started_at >=/, `${name} is bounded by the window`);
    }
    const environments = await explain(client, agentEnvironmentsQuery(PROJECT_ID, WINDOW));
    assert.match(environments, /started_at >=/, "environments is bounded by the window");
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
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other'),
      ('${SERVICE_ONLY_PROJECT_ID}', '${ORGANIZATION_ID}', 'Service only', 'service-only'),
      ('${ONE_NAMED_PROJECT_ID}', '${ORGANIZATION_ID}', 'One named', 'one-named'),
      ('${TWO_SERVICES_PROJECT_ID}', '${ORGANIZATION_ID}', 'Two services', 'two-services');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const supervisor = { agentKey: "supervisor", agentSource: "semconv" } as const;
  const researcher = {
    agentKey: "researcher",
    agentSource: "heuristic",
    callerAgentKey: "supervisor",
  } as const;
  const writer = {
    agentKey: "writer",
    agentSource: "heuristic",
    callerAgentKey: "supervisor",
  } as const;
  const invoke = (name: string) => ({
    name: `invoke_agent ${name}`,
    operationName: "invoke_agent",
  });
  const tool = (name: string) => ({
    name: `execute_tool ${name}`,
    spanClass: "tool",
    operationName: "execute_tool",
    attributes: { "gen_ai.tool.name": name },
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Trace 1, prod.
      span(1, {
        at: 0,
        durationMs: 1_000,
        traceId: traceId(1),
        ...supervisor,
        ...invoke("supervisor"),
      }),
      span(2, {
        at: 10,
        durationMs: 50,
        traceId: traceId(1),
        ...supervisor,
        spanClass: "llm_call",
        costUsd: "0.01",
      }),
      span(3, {
        at: 100,
        durationMs: 500,
        traceId: traceId(1),
        ...researcher,
        ...invoke("researcher"),
      }),
      span(4, { at: 150, durationMs: 40, traceId: traceId(1), ...researcher, ...tool("search") }),
      span(5, { at: 200, durationMs: 50, traceId: traceId(1), ...researcher, ...tool("search") }),
      span(6, {
        at: 300,
        durationMs: 30,
        traceId: traceId(1),
        ...researcher,
        kind: 3,
        mcpServer: "docs-mcp",
        mcpRole: "consumed",
        spanClass: "llm_call",
        costUsd: "0.004",
      }),
      // Trace 2, staging.
      span(11, {
        at: 10_000,
        durationMs: 2_000,
        traceId: traceId(2),
        ...supervisor,
        ...invoke("supervisor"),
      }),
      span(12, {
        at: 10_010,
        durationMs: 50,
        traceId: traceId(2),
        ...supervisor,
        spanClass: "llm_call",
        costUsd: "0.02",
      }),
      span(13, {
        at: 10_100,
        durationMs: 900,
        traceId: traceId(2),
        ...researcher,
        ...invoke("researcher"),
      }),
      span(14, {
        at: 10_400,
        durationMs: 30,
        traceId: traceId(2),
        ...researcher,
        ...tool("search"),
        statusCode: 2,
      }),
      span(15, {
        at: 11_000,
        durationMs: 300,
        traceId: traceId(2),
        ...writer,
        ...invoke("writer"),
      }),
      // Before the window.
      span(30, { at: -7_200_000, traceId: traceId(3), ...supervisor, ...invoke("supervisor") }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [span(50, { at: 0, projectId: OTHER_PROJECT_ID, traceId: traceId(1) })],
    db,
  );
  await client.exec(`
    insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, environment, agents, spans_max_received_at)
    values
      ('${PROJECT_ID}', '${traceId(1)}', '${new Date(T0).toISOString()}', 1000, false, 0, 0, 0.014, 'prod', '{supervisor,researcher}', now()),
      ('${PROJECT_ID}', '${traceId(2)}', '${new Date(T0 + 10_000).toISOString()}', 2000, true, 0, 0, 0.02, 'staging', '{supervisor,researcher,writer}', now()),
      ('${PROJECT_ID}', '${traceId(3)}', '${new Date(T0 - 7_200_000).toISOString()}', 100, false, 0, 0, 0, 'dev', '{supervisor}', now());
  `);
  return { client, db };
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
