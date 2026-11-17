import assert from "node:assert/strict";
import { test } from "node:test";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  getTraceAggregates,
  type ListTracesOptions,
  listTraces,
} from "@/lib/synthesis/traces/queries";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import {
  defaultTraceFilterFacetWindow,
  getTraceFilterFacets,
  traceFacetsQuery,
} from "@/lib/synthesis/traces/trace-filters";
import {
  type ListSessionListOptions,
  listSessionList,
  sessionListPageQuery,
} from "@/lib/synthesis/traces/v2/sessions-list";

/**
 * RC-505: the Sessions and Turns filters read the per-trace rollup. Seeded:
 * trace 1 (session-a): gpt-4o, tool lookup_order, service support, env prod.
 * trace 2 (session-a): claude-sonnet, no tool, failed, cost 0.5.
 * trace 3 (session-b): gpt-4o-mini, tool "execute_tool refund", service billing, env staging.
 * The rollup is filled by the summary sweep, the same path that backfills.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const NOW = new Date(T0 + 3_600_000);
const WINDOW = { since: new Date(T0 - 60_000), until: new Date(T0 + 60_000) };

type TestDb = Parameters<typeof listTraces>[2] &
  Parameters<typeof listSessionList>[2] &
  Parameters<typeof refreshTraceSummaries>[1] &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("the summary sweep fills each trace's models, tools, service and environment", async () => {
  const { client, db } = await seeded();
  try {
    const rows = await db
      .select({
        traceId: otelTraceSummaries.traceId,
        models: otelTraceSummaries.models,
        tools: otelTraceSummaries.tools,
        serviceName: otelTraceSummaries.serviceName,
        environment: otelTraceSummaries.environment,
      })
      .from(otelTraceSummaries)
      .orderBy(asc(otelTraceSummaries.traceId));
    assert.deepEqual(rows, [
      {
        traceId: traceId(1),
        models: ["gpt-4o"],
        tools: ["lookup_order"],
        serviceName: "support",
        environment: "prod",
      },
      {
        traceId: traceId(2),
        models: ["claude-sonnet"],
        tools: [],
        serviceName: "support",
        environment: "prod",
      },
      {
        traceId: traceId(3),
        models: ["gpt-4o-mini"],
        tools: ["refund"],
        serviceName: "billing",
        environment: "staging",
      },
    ]);
  } finally {
    await client.close();
  }
});

test("filter by model and by tool narrows the Turns list", async () => {
  const { client, db } = await seeded();
  try {
    const ids = async (traces: ListTracesOptions["traces"]) =>
      (await listTraces(PROJECT_ID, { ...WINDOW, traces }, db)).items
        .map((item) => item.traceId)
        .sort();
    assert.deepEqual(await ids(undefined), [traceId(1), traceId(2), traceId(3)]);
    assert.deepEqual(await ids({ models: ["gpt-4o"] }), [traceId(1)]);
    assert.deepEqual(await ids({ models: ["gpt-4o", "gpt-4o-mini"] }), [traceId(1), traceId(3)]);
    assert.deepEqual(await ids({ tools: ["refund"] }), [traceId(3)]);
    assert.deepEqual(await ids({ services: ["support"] }), [traceId(1), traceId(2)]);
    assert.deepEqual(await ids({ environments: ["staging"] }), [traceId(3)]);
    assert.deepEqual(await ids({ status: "failed" }), [traceId(2)]);
    assert.deepEqual(await ids({ status: "ok" }), [traceId(1), traceId(3)]);
    assert.deepEqual(await ids({ minCostUsd: 0.1 }), [traceId(2)]);
    assert.deepEqual(await ids({ minTokens: 100 }), [traceId(3)]);
    assert.deepEqual(await ids({ models: ["gpt-4o"], tools: ["refund"] }), []);
  } finally {
    await client.close();
  }
});

test("a trace that starts before the window but has an in-window root is in the filtered list as in the unfiltered one", async () => {
  const { client, db } = await seeded();
  try {
    // Trace 4 has two roots: one an hour before the window, one inside it.
    await insertOtelSpans(
      PROJECT_ID,
      [
        span(40, { traceId: traceId(4), at: -3_600_000 }),
        span(41, { traceId: traceId(4), at: 30_000 }),
        span(42, {
          traceId: traceId(4),
          parentSpanId: spanId(41),
          at: 30_001,
          spanClass: "llm_call",
          name: "chat",
          model: "gpt-4o",
        }),
      ],
      db,
    );
    await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
    const ids = async (traces: ListTracesOptions["traces"]) =>
      (await listTraces(PROJECT_ID, { ...WINDOW, traces }, db)).items
        .map((item) => item.traceId)
        .sort();
    assert.ok((await ids(undefined)).includes(traceId(4)));
    assert.deepEqual(await ids({ models: ["gpt-4o"] }), [traceId(1), traceId(4)]);
    const totals = await getTraceAggregates(
      PROJECT_ID,
      { ...WINDOW, traces: { models: ["gpt-4o"] } },
      db,
    );
    assert.equal(totals.count, 2);
  } finally {
    await client.close();
  }
});

test("the Turns totals follow the same filter", async () => {
  const { client, db } = await seeded();
  try {
    const all = await getTraceAggregates(PROJECT_ID, { ...WINDOW }, db);
    const gpt = await getTraceAggregates(
      PROJECT_ID,
      { ...WINDOW, traces: { models: ["gpt-4o", "gpt-4o-mini"] } },
      db,
    );
    assert.deepEqual([all.count, gpt.count, gpt.totalTokens], [3, 2, 135]);
  } finally {
    await client.close();
  }
});

test("filter by model and by tool narrows Sessions: a session matches when any of its turns matches", async () => {
  const { client, db } = await seeded();
  try {
    const ids = async (traces: ListSessionListOptions["traces"]) =>
      (await listSessionList(PROJECT_ID, { filter: "all", now: NOW, traces }, db)).items
        .map((row) => row.id)
        .sort();
    assert.deepEqual(await ids(undefined), ["session-a", "session-b"]);
    assert.deepEqual(await ids({ models: ["claude-sonnet"] }), ["session-a"]);
    assert.deepEqual(await ids({ tools: ["refund"] }), ["session-b"]);
    assert.deepEqual(await ids({ tools: ["lookup_order", "refund"] }), ["session-a", "session-b"]);
    assert.deepEqual(await ids({ environments: ["staging"], status: "failed" }), []);
    // Both page CTEs at once: the Failed tab under a model filter.
    const failed = await listSessionList(
      PROJECT_ID,
      { filter: "failed", now: NOW, traces: { models: ["claude-sonnet", "gpt-4o-mini"] } },
      db,
    );
    assert.deepEqual(
      failed.items.map((row) => row.id),
      ["session-a"],
    );
  } finally {
    await client.close();
  }
});

test("facet values for a project and window come from one rollup query", async () => {
  const { client, db } = await seeded();
  try {
    const facets = await getTraceFilterFacets(PROJECT_ID, WINDOW, db);
    assert.deepEqual(facets, {
      model: [
        { value: "claude-sonnet", count: 1 },
        { value: "gpt-4o", count: 1 },
        { value: "gpt-4o-mini", count: 1 },
      ],
      tool: [
        { value: "lookup_order", count: 1 },
        { value: "refund", count: 1 },
      ],
      service: [
        { value: "support", count: 2 },
        { value: "billing", count: 1 },
      ],
      environment: [
        { value: "prod", count: 2 },
        { value: "staging", count: 1 },
      ],
    });
    const text = JSON.stringify(traceFacetsQuery(PROJECT_ID, WINDOW, 10));
    assert.match(text, /otel_trace_summaries/);
    assert.doesNotMatch(text, /otel_spans/);
  } finally {
    await client.close();
  }
});

test("the Sessions facet window is the Turns default range: it ignores rows outside it", async () => {
  const { client, db } = await seeded();
  try {
    const inside = await getTraceFilterFacets(PROJECT_ID, defaultTraceFilterFacetWindow(NOW), db);
    assert.deepEqual(
      inside.model.map((facet) => facet.value),
      ["claude-sonnet", "gpt-4o", "gpt-4o-mini"],
    );
    // A month later the seeded traces fall outside the default 7-day window.
    const later = await getTraceFilterFacets(
      PROJECT_ID,
      defaultTraceFilterFacetWindow(new Date(T0 + 30 * 86_400_000)),
      db,
    );
    assert.deepEqual(later, { model: [], tool: [], service: [], environment: [] });
  } finally {
    await client.close();
  }
});

test("the Sessions filter finds the matching sessions once per page, not once per walked head", () => {
  const text = JSON.stringify(
    sessionListPageQuery(PROJECT_ID, "failed", null, 51, { models: ["gpt-4o"] }),
  );
  assert.match(text, /failed_sessions as \(/);
  assert.match(text, /matched_sessions as \(/);
  assert.match(text, /t\.session_id in \(select session_id from matched_sessions\)/);
  // The match never reads the walked head (only the head walk's own "newest turn" check does).
  assert.doesNotMatch(text, /m\.session_id = t\.session_id/);
  assert.doesNotMatch(text, /s\.project_id = t\.project_id/);
});

test("without a filter the list queries are unchanged", () => {
  const plain = JSON.stringify(sessionListPageQuery(PROJECT_ID, "all", null, 51));
  assert.equal(JSON.stringify(sessionListPageQuery(PROJECT_ID, "all", null, 51, {})), plain);
  assert.equal(JSON.stringify(sessionListPageQuery(PROJECT_ID, "all", null, 51, undefined)), plain);
});

async function seeded(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: TestDb;
}> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const prod = { "deployment.environment.name": "prod" };
  await insertOtelSpans(
    PROJECT_ID,
    [
      span(10, { traceId: traceId(1), at: 0, serviceName: "support", attributes: prod }),
      span(11, {
        traceId: traceId(1),
        parentSpanId: spanId(10),
        at: 1,
        spanClass: "llm_call",
        name: "chat gpt-4o",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
      }),
      span(12, {
        traceId: traceId(1),
        parentSpanId: spanId(10),
        at: 2,
        spanClass: "tool",
        name: "execute_tool",
        attributes: { "gen_ai.tool.name": "lookup_order" },
      }),
      span(20, { traceId: traceId(2), at: 10_000, serviceName: "support", attributes: prod }),
      span(21, {
        traceId: traceId(2),
        parentSpanId: spanId(20),
        at: 10_001,
        spanClass: "llm_call",
        name: "chat",
        model: "claude-sonnet",
        statusCode: 2,
        costUsd: "0.500000",
      }),
      span(30, {
        traceId: traceId(3),
        at: 20_000,
        serviceName: "billing",
        attributes: { "deployment.environment": "staging" },
      }),
      span(31, {
        traceId: traceId(3),
        parentSpanId: spanId(30),
        at: 20_001,
        spanClass: "llm_call",
        name: "chat",
        model: " gpt-4o-mini ",
        inputTokens: 90,
        outputTokens: 30,
      }),
      span(32, {
        traceId: traceId(3),
        parentSpanId: spanId(30),
        at: 20_002,
        spanClass: "tool",
        name: "execute_tool refund",
      }),
    ],
    db,
  );
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  const turn = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const row = (id: number, session: string, trace: number, start: number) =>
    `('${turn(id)}', '${PROJECT_ID}', '${session}', 'otlp:${traceId(trace)}', 'otlp', 'otlp', 'closed', '${iso(start)}', '${iso(start + 100)}', '${iso(start + 100)}', 0)`;
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, error_count) values
      ${[row(1, "session-a", 1, 0), row(2, "session-a", 2, 10_000), row(3, "session-b", 3, 20_000)].join(",\n      ")};
  `);
  return { client, db };
}

function iso(offset: number): string {
  return new Date(T0 + offset).toISOString();
}

function traceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  return {
    id: `00000000-0000-8000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    receivedAt: new Date(T0 - 3_600_000 + index),
    traceId: traceId(index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "invoke_agent support-agent",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(T0 + at),
    endedAt: new Date(T0 + at + 100),
    durationMs: 100,
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
