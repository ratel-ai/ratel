import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { SessionsDb } from "./cursor";
import { getLogsAggregate, getSessionsAggregate, getSpansAggregate } from "./tab-aggregates";

/**
 * RC-331: the aggregate behind each Traces tab's summary, on a seeded project.
 * In the window: session-a (two runs, the second failed a tool call, $0.02),
 * session-b (runtime lane, an error step), session-open (its turn is still
 * open), run 5 (failed root) and run 6 (two roots, $0.005). Runs 5 and 6 have
 * no session, so the Sessions list does not show them and the summary does
 * not count them (RC-752). Out of the window: session-old and run 8, a day
 * before. Another project's rows are newer than all of them.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const DAY = 86_400_000;
const WINDOW = { since: new Date(T0 - 3_600_000), until: new Date(T0 + 3_600_000) };

type TestDb = SessionsDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("getSessionsAggregate counts sessions, open or closed, as the list shows them", async () => {
  const { client, db } = await seeded();
  try {
    const aggregate = await getSessionsAggregate(
      PROJECT_ID,
      { ...WINDOW, volumeBucket: "hour" },
      db,
    );
    assert.deepEqual(
      { count: aggregate.count, failed: aggregate.failed, p50DurationMs: aggregate.p50DurationMs },
      { count: 3, failed: 2, p50DurationMs: 1_000 },
      "session-a, session-b and session-open; a and b failed; durations 10 100, 1 000, 100 ms",
    );
    assert.ok(Math.abs(aggregate.costUsd - 0.02) < 1e-9, `cost ${aggregate.costUsd}`);
    assert.deepEqual(aggregate.volume, [{ day: "2026-11-02", hour: 9, count: 3, errorCount: 2 }]);
    const daily = await getSessionsAggregate(PROJECT_ID, WINDOW, db);
    assert.deepEqual(daily.volume, [{ day: "2026-11-02", count: 3, errorCount: 2 }]);
  } finally {
    await client.close();
  }
});

test("getSessionsAggregate reads an empty window as zeros and never another project", async () => {
  const { client, db } = await seeded();
  try {
    const empty = await getSessionsAggregate(
      PROJECT_ID,
      { since: new Date(T0 + 10 * DAY), until: new Date(T0 + 11 * DAY) },
      db,
    );
    assert.deepEqual(empty, { count: 0, failed: 0, p50DurationMs: null, costUsd: 0, volume: [] });
    const other = await getSessionsAggregate(OTHER_PROJECT_ID, WINDOW, db);
    assert.deepEqual(
      { count: other.count, failed: other.failed },
      { count: 1, failed: 1 },
      "session-x (its trace 1 failed there); run 7 has no session",
    );
  } finally {
    await client.close();
  }
});

test("getSpansAggregate counts the window's spans, errors, percentiles and kinds", async () => {
  const { client, db } = await seeded();
  try {
    const aggregate = await getSpansAggregate(PROJECT_ID, { ...WINDOW, volumeBucket: "hour" }, db);
    assert.equal(aggregate.count, 11);
    assert.equal(aggregate.errorCount, 2);
    assert.equal(aggregate.p50DurationMs, 100);
    assert.equal(aggregate.p95DurationMs, 100);
    assert.deepEqual(aggregate.kinds, [
      { kind: 1, count: 10 },
      { kind: 3, count: 1 },
    ]);
    assert.deepEqual(aggregate.volume, [{ day: "2026-11-02", hour: 9, count: 11, errorCount: 2 }]);
  } finally {
    await client.close();
  }
});

test("getLogsAggregate counts the window's records by severity, errors in the volume", async () => {
  const { client, db } = await seeded();
  try {
    const aggregate = await getLogsAggregate(PROJECT_ID, { ...WINDOW, volumeBucket: "hour" }, db);
    assert.equal(aggregate.count, 6);
    assert.deepEqual(aggregate.severities, [
      { severityNumber: 0, count: 1 },
      { severityNumber: 9, count: 2 },
      { severityNumber: 13, count: 1 },
      { severityNumber: 17, count: 1 },
      { severityNumber: 21, count: 1 },
    ]);
    assert.deepEqual(aggregate.volume, [
      { day: "2026-11-02", hour: 8, count: 1, errorCount: 0 },
      { day: "2026-11-02", hour: 9, count: 5, errorCount: 2 },
    ]);
    const other = await getLogsAggregate(OTHER_PROJECT_ID, WINDOW, db);
    assert.equal(other.count, 1);
  } finally {
    await client.close();
  }
});

async function seeded(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: TestDb;
}> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  await insertOtelSpans(
    PROJECT_ID,
    [
      // session-a: run 1 clean, run 2 failed a tool call.
      span(10, { traceId: traceId(1), at: T0, costUsd: "0.01" }),
      span(11, { traceId: traceId(1), parentSpanId: spanId(10), kind: 3, at: T0 + 1 }),
      span(20, { traceId: traceId(2), at: T0 + 10_000, costUsd: "0.01" }),
      span(21, { traceId: traceId(2), parentSpanId: spanId(20), at: T0 + 10_001, statusCode: 2 }),
      // run 4: its turn is still open.
      span(40, { traceId: traceId(4), at: T0 + 15_000 }),
      // run 5: no turn, ended in an error.
      span(50, { traceId: traceId(5), at: T0 + 30_000, statusCode: 2 }),
      // run 6: no turn, a second root later in the run is not a second run.
      span(60, { traceId: traceId(6), at: T0 + 1_000, costUsd: "0.005" }),
      span(61, { traceId: traceId(6), parentSpanId: spanId(60), at: T0 + 1_001 }),
      span(62, { traceId: traceId(6), at: T0 + 1_050 }),
      // session-old's run and run 8: a day before the window.
      span(70, { traceId: traceId(9), at: T0 - DAY }),
      span(80, { traceId: traceId(8), at: T0 - DAY, statusCode: 2 }),
      // A late span of run 1, still in the window.
      span(12, { traceId: traceId(1), parentSpanId: spanId(10), at: T0 + 2 }),
      span(13, { traceId: traceId(1), parentSpanId: spanId(10), at: T0 + 3 }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span(90, { projectId: OTHER_PROJECT_ID, traceId: traceId(1), at: T0 + 40_000 }),
      span(91, {
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(1),
        parentSpanId: spanId(90),
        at: T0 + 40_001,
        statusCode: 2,
      }),
      span(92, { projectId: OTHER_PROJECT_ID, traceId: traceId(7), at: T0 + 50_000 }),
    ],
    db,
  );

  const turn = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const row = (
    id: number,
    project: string,
    session: string,
    key: string,
    lane: string,
    status: string,
    start: number,
    end: number,
    errors = 0,
  ) =>
    `('${turn(id)}', '${project}', '${session}', '${key}', '${lane === "otlp" ? "otlp" : "declared"}', '${lane}', '${status}', '${iso(start)}', '${iso(end)}', '${iso(end)}', ${errors})`;
  const log = (n: number, project: string, at: number, severity: number) =>
    `('00000000-0000-4000-9000-${n.toString().padStart(12, "0")}', '${project}', '${iso(at)}', 'agent.event', ${severity}, '{}'::jsonb)`;
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, error_count) values
      ${[
        row(1, PROJECT_ID, "session-a", `otlp:${traceId(1)}`, "otlp", "closed", 0, 100),
        row(2, PROJECT_ID, "session-a", `otlp:${traceId(2)}`, "otlp", "closed", 10_000, 10_100),
        row(3, PROJECT_ID, "session-b", "declared:b1", "runtime", "closed", 4_000, 5_000, 1),
        row(4, PROJECT_ID, "session-open", `otlp:${traceId(4)}`, "otlp", "open", 15_000, 15_100),
        row(6, PROJECT_ID, "session-old", `otlp:${traceId(9)}`, "otlp", "closed", -DAY, -DAY + 100),
        row(
          9,
          OTHER_PROJECT_ID,
          "session-x",
          `otlp:${traceId(1)}`,
          "otlp",
          "closed",
          40_000,
          45_000,
        ),
      ].join(",\n      ")};
    insert into otel_logs (id, project_id, occurred_at, event_name, severity_number, attributes) values
      ${[
        log(1, PROJECT_ID, -60_000, 9),
        log(2, PROJECT_ID, 0, 9),
        log(3, PROJECT_ID, 1_000, 13),
        log(4, PROJECT_ID, 2_000, 17),
        log(5, PROJECT_ID, 3_000, 21),
        log(6, PROJECT_ID, 4_000, 0),
        log(7, PROJECT_ID, -DAY, 17),
        log(8, OTHER_PROJECT_ID, 5_000, 17),
      ].join(",\n      ")};
  `);
  return { client, db };
}

function iso(offset: number): string {
  return new Date(T0 + offset).toISOString();
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  return {
    id: `00000000-0000-8000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    traceId: traceId(index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "invoke_agent support-agent",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(at),
    endedAt: new Date(at + 100),
    durationMs: 100,
    statusCode: 1,
    serviceName: "fixture-agent",
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

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return `a${value.toString(16).padStart(31, "0")}`;
}
