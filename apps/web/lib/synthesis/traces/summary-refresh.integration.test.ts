import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { otelTraceSummaries, traceSummaryCursor } from "@/lib/synthesis/traces/schema";
import {
  refreshTraceSummaries,
  TRACE_SUMMARY_CURSOR_ID,
  type TraceSummaryRefreshDb,
} from "./summary-refresh";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

type TestDb = TraceSummaryRefreshDb &
  NonNullable<Parameters<typeof insertOtelSpans>[2]> &
  Pick<ReturnType<typeof getDb>, "select" | "update">;

test("refresh summarizes each trace from its canonical whole-trace representative", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Rooted trace: the true root wins even though a child starts later.
      span({
        id: uuid(10),
        traceId: traceId(10),
        spanId: spanId(10),
        startedAt: at("10:00:00.000"),
        durationMs: 100,
        inputTokens: 5,
        outputTokens: 1,
        costUsd: "0.001000",
      }),
      span({
        id: uuid(11),
        traceId: traceId(10),
        spanId: spanId(11),
        parentSpanId: spanId(10),
        startedAt: at("10:00:00.200"),
        durationMs: 20,
        statusCode: 2,
        inputTokens: 3,
        outputTokens: 2,
        costUsd: "0.002000",
      }),
      // Rootless trace (malformed export): earliest span is promoted, which is
      // the second-inserted one — insertion order must not decide.
      span({
        id: uuid(20),
        traceId: traceId(20),
        spanId: spanId(20),
        parentSpanId: spanId(999),
        startedAt: at("11:00:00.500"),
        durationMs: 250,
        inputTokens: 7,
      }),
      span({
        id: uuid(21),
        traceId: traceId(20),
        spanId: spanId(21),
        parentSpanId: spanId(20),
        startedAt: at("11:00:00.100"),
        durationMs: 40,
        outputTokens: 4,
      }),
      // Multi-root trace: the earliest root wins over a later root and over an
      // even-later child.
      span({
        id: uuid(30),
        traceId: traceId(30),
        spanId: spanId(30),
        startedAt: at("12:00:00.300"),
        durationMs: 300,
      }),
      span({
        id: uuid(31),
        traceId: traceId(30),
        spanId: spanId(31),
        startedAt: at("12:00:00.100"),
        durationMs: 500,
      }),
      span({
        id: uuid(32),
        traceId: traceId(30),
        spanId: spanId(32),
        parentSpanId: spanId(31),
        startedAt: at("12:00:00.400"),
        durationMs: 10,
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(40),
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(10),
        spanId: spanId(40),
        startedAt: at("13:00:00.000"),
        durationMs: 900,
        statusCode: 2,
        inputTokens: 1_000,
      }),
    ],
    db,
  );

  const result = await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  assert.deepEqual(
    {
      spansScanned: result.spansScanned,
      tracesRecomputed: result.tracesRecomputed,
      caughtUp: result.caughtUp,
      lockContended: result.lockContended,
    },
    {
      spansScanned: 8,
      tracesRecomputed: 4,
      caughtUp: true,
      lockContended: false,
    },
  );
  assert.deepEqual(await readSummaries(db), [
    {
      projectId: PROJECT_ID,
      traceId: traceId(10),
      startedAt: at("10:00:00.000"),
      durationMs: 100,
      hasError: true,
      inputTokens: 8,
      outputTokens: 3,
      costUsd: "0.003000",
    },
    {
      projectId: PROJECT_ID,
      traceId: traceId(20),
      startedAt: at("11:00:00.100"),
      durationMs: 40,
      hasError: false,
      inputTokens: 7,
      outputTokens: 4,
      costUsd: "0.000000",
    },
    {
      projectId: PROJECT_ID,
      traceId: traceId(30),
      startedAt: at("12:00:00.100"),
      durationMs: 500,
      hasError: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: "0.000000",
    },
    {
      projectId: OTHER_PROJECT_ID,
      traceId: traceId(10),
      startedAt: at("13:00:00.000"),
      durationMs: 900,
      hasError: true,
      inputTokens: 1_000,
      outputTokens: 0,
      costUsd: "0.000000",
    },
  ]);
  // Same trace id under two projects stays two independent rows, and the
  // retention key tracks server receipt rather than producer start.
  const [summary] = await db
    .select({ spansMaxReceivedAt: otelTraceSummaries.spansMaxReceivedAt })
    .from(otelTraceSummaries)
    .where(eq(otelTraceSummaries.projectId, OTHER_PROJECT_ID));
  assert.deepEqual(summary?.spansMaxReceivedAt, received(2));
  await client.close();
});

test("refresh recomputes a trace in full when later spans arrive", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(50),
        traceId: traceId(50),
        spanId: spanId(50),
        parentSpanId: spanId(999),
        startedAt: at("09:00:00.500"),
        durationMs: 50,
        inputTokens: 2,
        costUsd: "0.001000",
        receivedAt: received(1),
      }),
    ],
    db,
  );

  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  assert.deepEqual(await readSummaries(db), [
    {
      projectId: PROJECT_ID,
      traceId: traceId(50),
      startedAt: at("09:00:00.500"),
      durationMs: 50,
      hasError: false,
      inputTokens: 2,
      outputTokens: 0,
      costUsd: "0.001000",
    },
  ]);

  // A true root and an erroring sibling land later: the representative swaps to
  // the root and the whole-trace sums grow.
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(51),
        traceId: traceId(50),
        spanId: spanId(51),
        startedAt: at("09:00:00.000"),
        durationMs: 400,
        inputTokens: 6,
        outputTokens: 3,
        costUsd: "0.002000",
        receivedAt: received(2),
      }),
      span({
        id: uuid(52),
        traceId: traceId(50),
        spanId: spanId(52),
        parentSpanId: spanId(51),
        startedAt: at("09:00:00.900"),
        durationMs: 5,
        statusCode: 2,
        receivedAt: received(2),
      }),
    ],
    db,
  );
  const result = await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  assert.deepEqual(
    { spansScanned: result.spansScanned, tracesRecomputed: result.tracesRecomputed },
    { spansScanned: 2, tracesRecomputed: 1 },
  );
  assert.deepEqual(await readSummaries(db), [
    {
      projectId: PROJECT_ID,
      traceId: traceId(50),
      startedAt: at("09:00:00.000"),
      durationMs: 400,
      hasError: true,
      inputTokens: 8,
      outputTokens: 3,
      costUsd: "0.003000",
    },
  ]);
  await client.close();
});

test("refresh is idempotent — a replayed cursor recomputes rather than accumulates", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(60),
        traceId: traceId(60),
        spanId: spanId(60),
        durationMs: 120,
        inputTokens: 11,
        outputTokens: 7,
        costUsd: "0.004000",
        receivedAt: received(1),
      }),
      span({
        id: uuid(61),
        traceId: traceId(60),
        spanId: spanId(61),
        parentSpanId: spanId(60),
        inputTokens: 9,
        costUsd: "0.001000",
        receivedAt: received(1),
      }),
    ],
    db,
  );

  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  const afterFirst = await readSummaries(db);

  // Nothing new: the sweep is a no-op and reports itself caught up.
  const idle = await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  assert.deepEqual(
    {
      spansScanned: idle.spansScanned,
      tracesRecomputed: idle.tracesRecomputed,
      caughtUp: idle.caughtUp,
    },
    { spansScanned: 0, tracesRecomputed: 0, caughtUp: true },
  );
  assert.deepEqual(await readSummaries(db), afterFirst);

  // Replaying the whole history (as an overlapping tick or a rewound cursor
  // would) must reproduce the same row, never double-count into it.
  await rewindCursor(db);
  const replay = await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  assert.equal(replay.spansScanned, 2);
  assert.deepEqual(await readSummaries(db), afterFirst);
  assert.deepEqual(afterFirst, [
    {
      projectId: PROJECT_ID,
      traceId: traceId(60),
      startedAt: at("10:00:00.000"),
      durationMs: 120,
      hasError: false,
      inputTokens: 20,
      outputTokens: 7,
      costUsd: "0.005000",
    },
  ]);
  await client.close();
});

test("refresh advances the cursor to the last span it folded in", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(70),
        traceId: traceId(70),
        spanId: spanId(70),
        receivedAt: received(1),
      }),
      span({
        id: uuid(71),
        traceId: traceId(71),
        spanId: spanId(71),
        receivedAt: received(3),
      }),
    ],
    db,
  );

  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  assert.deepEqual(await readCursor(db), {
    id: TRACE_SUMMARY_CURSOR_ID,
    receivedAt: received(3),
    spanRowId: uuid(71),
  });
  await client.close();
});

test("refresh honors its batch and time budget, then resumes from the cursor", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(80),
        traceId: traceId(80),
        spanId: spanId(80),
        durationMs: 10,
        receivedAt: received(1),
      }),
      span({
        id: uuid(81),
        traceId: traceId(81),
        spanId: spanId(81),
        durationMs: 20,
        receivedAt: received(2),
      }),
      span({
        id: uuid(82),
        traceId: traceId(82),
        spanId: spanId(82),
        durationMs: 30,
        receivedAt: received(3),
      }),
    ],
    db,
  );

  // One batch of one span, then the clock exhausts the budget.
  const bounded = await refreshTraceSummaries(
    {
      batchSize: 1,
      timeBudgetMs: 10,
      visibilityLagMs: 0,
      now: fakeClock([0, 0, 10]),
    },
    db,
  );

  assert.deepEqual(
    {
      spansScanned: bounded.spansScanned,
      tracesRecomputed: bounded.tracesRecomputed,
      batches: bounded.batches,
      caughtUp: bounded.caughtUp,
    },
    { spansScanned: 1, tracesRecomputed: 1, batches: 1, caughtUp: false },
  );
  assert.deepEqual(
    (await readSummaries(db)).map(({ traceId: id }) => id),
    [traceId(80)],
  );
  assert.equal((await readCursor(db))?.receivedAt.getTime(), received(1).getTime());

  // A later tick resumes where the budget cut off and drains the rest.
  const resumed = await refreshTraceSummaries({ batchSize: 1, visibilityLagMs: 0 }, db);

  assert.deepEqual(
    {
      spansScanned: resumed.spansScanned,
      tracesRecomputed: resumed.tracesRecomputed,
      caughtUp: resumed.caughtUp,
    },
    { spansScanned: 2, tracesRecomputed: 2, caughtUp: true },
  );
  assert.deepEqual(
    (await readSummaries(db)).map(({ traceId: id }) => id),
    [traceId(80), traceId(81), traceId(82)],
  );
  await client.close();
});

test("refresh skips spans newer than the visibility lag until they settle", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(90),
        traceId: traceId(90),
        spanId: spanId(90),
        // Just-received, i.e. possibly still inside an in-flight ingest txn.
        receivedAt: new Date(),
      }),
    ],
    db,
  );

  const withheld = await refreshTraceSummaries({ visibilityLagMs: 60_000 }, db);

  assert.deepEqual(
    { spansScanned: withheld.spansScanned, caughtUp: withheld.caughtUp },
    { spansScanned: 0, caughtUp: true },
  );
  assert.deepEqual(await readSummaries(db), []);
  assert.equal(await readCursor(db), undefined);

  assert.equal((await refreshTraceSummaries({ visibilityLagMs: 0 }, db)).spansScanned, 1);
  await client.close();
});

test("refresh releases its advisory lock and yields to a contending tick", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [span({ id: uuid(95), traceId: traceId(95), spanId: spanId(95) })],
    db,
  );

  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);

  const held = await client.query<{ count: number }>(
    "select count(*)::int as count from pg_locks where locktype = 'advisory'",
  );
  assert.equal(held.rows[0]?.count, 0);

  // A tick that loses the race does no work rather than duplicating it.
  const contended = await refreshTraceSummaries({}, contendedDb());

  assert.deepEqual(contended, {
    spansScanned: 0,
    tracesRecomputed: 0,
    batches: 0,
    caughtUp: false,
    lockContended: true,
  });
  await client.close();
});

async function setup(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as TestDb,
  };
}

function readSummaries(db: TestDb) {
  return db
    .select({
      projectId: otelTraceSummaries.projectId,
      traceId: otelTraceSummaries.traceId,
      startedAt: otelTraceSummaries.startedAt,
      durationMs: otelTraceSummaries.durationMs,
      hasError: otelTraceSummaries.hasError,
      inputTokens: otelTraceSummaries.inputTokens,
      outputTokens: otelTraceSummaries.outputTokens,
      costUsd: otelTraceSummaries.costUsd,
    })
    .from(otelTraceSummaries)
    .orderBy(asc(otelTraceSummaries.projectId), asc(otelTraceSummaries.traceId));
}

async function readCursor(db: TestDb) {
  const [row] = await db
    .select({
      id: traceSummaryCursor.id,
      receivedAt: traceSummaryCursor.receivedAt,
      spanRowId: traceSummaryCursor.spanRowId,
    })
    .from(traceSummaryCursor);
  return row;
}

async function rewindCursor(db: TestDb): Promise<void> {
  await db
    .update(traceSummaryCursor)
    .set({ receivedAt: new Date(0), spanRowId: uuid(0) })
    .where(eq(traceSummaryCursor.id, TRACE_SUMMARY_CURSOR_ID));
}

/** A db whose advisory-lock probe always loses, i.e. an overlapping tick. */
function contendedDb(): TraceSummaryRefreshDb {
  return {
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ execute: async () => ({ rows: [{ locked: false }] }) }),
  } as unknown as TraceSummaryRefreshDb;
}

function fakeClock(readings: number[]): () => number {
  let last = 0;
  return () => {
    last = readings.shift() ?? last;
    return last;
  };
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  const startedAt = overrides.startedAt ?? at("10:00:00.000");
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    receivedAt: received(2),
    traceId: traceId(1),
    spanId: spanId(1),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    endedAt: overrides.endedAt ?? new Date(startedAt.getTime() + 100),
    durationMs: overrides.durationMs ?? 100,
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
    ...overrides,
    startedAt,
  };
}

/** A producer clock time on the fixture day. */
function at(time: string): Date {
  return new Date(`2026-07-30T${time}Z`);
}

/** A server receipt time; higher `step` sorts later on the sweep cursor. */
function received(step: number): Date {
  return new Date(`2026-07-30T08:00:0${step}.000Z`);
}

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return value.toString(16).padStart(32, "0");
}
