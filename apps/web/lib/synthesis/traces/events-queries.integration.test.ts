import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import type { NewOtelLog } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { type EventQueriesDb, listProjectEvents } from "./events-queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

type TestDb = EventQueriesDb & NonNullable<Parameters<typeof insertOtelLogs>[2]>;

test("listProjectEvents pages project events newest first with their full payload", async () => {
  const { client, db } = await setup();
  const newest = otelLog({
    id: uuid(3),
    occurredAt: new Date("2026-07-30T12:00:00.000Z"),
    eventName: "ratel.experiment.outcome",
    traceId: null,
    spanId: null,
    serviceName: "outcome-worker",
    experimentName: "ranking-v2",
    experimentArm: "candidate",
    experimentRole: "shadow",
    body: { label: "accepted" },
    experimentAttrs: { "ratel.experiment.outcome.score": 0.8 },
    attributes: { "ratel.worker.region": "eu-west-1" },
    attrsTruncated: true,
  });
  const middle = otelLog({
    id: uuid(2),
    occurredAt: new Date("2026-07-30T11:00:00.000Z"),
    eventName: "ratel.experiment.comparison",
  });
  const oldest = otelLog({
    id: uuid(1),
    occurredAt: new Date("2026-07-30T10:00:00.000Z"),
    eventName: "ratel.tool.call",
  });
  await insertOtelLogs(PROJECT_ID, [middle, oldest, newest], db);
  await insertOtelLogs(
    OTHER_PROJECT_ID,
    [
      otelLog({
        id: uuid(4),
        occurredAt: new Date("2026-07-30T13:00:00.000Z"),
      }),
    ],
    db,
  );

  const first = await listProjectEvents(PROJECT_ID, { limit: 2 }, db);

  assert.deepEqual(first, {
    items: [
      {
        id: newest.id,
        occurredAt: newest.occurredAt,
        eventName: newest.eventName,
        traceId: newest.traceId,
        spanId: newest.spanId,
        serviceName: newest.serviceName,
        experimentName: newest.experimentName,
        experimentArm: newest.experimentArm,
        experimentRole: newest.experimentRole,
        body: newest.body,
        experimentAttrs: newest.experimentAttrs,
        attributes: newest.attributes,
        attrsTruncated: newest.attrsTruncated,
      },
      {
        id: middle.id,
        occurredAt: middle.occurredAt,
        eventName: middle.eventName,
        traceId: middle.traceId,
        spanId: middle.spanId,
        serviceName: middle.serviceName,
        experimentName: middle.experimentName,
        experimentArm: middle.experimentArm,
        experimentRole: middle.experimentRole,
        body: middle.body,
        experimentAttrs: middle.experimentAttrs,
        attributes: middle.attributes,
        attrsTruncated: middle.attrsTruncated,
      },
    ],
    hasMore: true,
    nextCursor: { occurredAt: middle.occurredAt, id: middle.id },
  });

  const second = await listProjectEvents(PROJECT_ID, { limit: 2, cursor: first.nextCursor! }, db);

  assert.deepEqual(second, {
    items: [
      {
        id: oldest.id,
        occurredAt: oldest.occurredAt,
        eventName: oldest.eventName,
        traceId: oldest.traceId,
        spanId: oldest.spanId,
        serviceName: oldest.serviceName,
        experimentName: oldest.experimentName,
        experimentArm: oldest.experimentArm,
        experimentRole: oldest.experimentRole,
        body: oldest.body,
        experimentAttrs: oldest.experimentAttrs,
        attributes: oldest.attributes,
        attrsTruncated: oldest.attrsTruncated,
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  await client.close();
});

test("listProjectEvents breaks occurredAt ties by id without duplicates or gaps", async () => {
  const { client, db } = await setup();
  const tiedAt = new Date("2026-07-30T12:00:00.000Z");
  await insertOtelLogs(
    PROJECT_ID,
    [
      otelLog({
        id: uuid(70),
        occurredAt: tiedAt,
      }),
      otelLog({
        id: uuid(72),
        occurredAt: tiedAt,
      }),
      otelLog({
        id: uuid(71),
        occurredAt: tiedAt,
      }),
      otelLog({
        id: uuid(69),
        occurredAt: new Date("2026-07-30T11:59:59.000Z"),
      }),
    ],
    db,
  );

  const first = await listProjectEvents(PROJECT_ID, { limit: 2 }, db);
  assert.deepEqual(
    first.items.map(({ id }) => id),
    [uuid(72), uuid(71)],
  );
  assert.deepEqual(first.nextCursor, {
    occurredAt: tiedAt,
    id: uuid(71),
  });

  const second = await listProjectEvents(PROJECT_ID, { limit: 2, cursor: first.nextCursor! }, db);
  assert.deepEqual(
    second.items.map(({ id }) => id),
    [uuid(70), uuid(69)],
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  await client.close();
});

test("listProjectEvents filters event and experiment values by substring", async () => {
  const { client, db } = await setup();
  await insertOtelLogs(
    PROJECT_ID,
    [
      otelLog({
        id: uuid(80),
        occurredAt: new Date("2026-07-30T10:00:00.000Z"),
        eventName: "ratel.experiment.results",
        experimentName: "ranking-v2",
      }),
      otelLog({
        id: uuid(81),
        occurredAt: new Date("2026-07-30T10:01:00.000Z"),
        eventName: "ratel.experiment.comparison",
        experimentName: "ranking-v2",
        traceId: null,
      }),
      otelLog({
        id: uuid(82),
        occurredAt: new Date("2026-07-30T10:02:00.000Z"),
        eventName: "ratel.experiment.comparison",
        experimentName: "retrieval-v3",
      }),
      otelLog({
        id: uuid(83),
        occurredAt: new Date("2026-07-30T10:03:00.000Z"),
        eventName: "ratel.experiment.outcome",
        experimentName: "ranking-v2",
        traceId: null,
      }),
    ],
    db,
  );

  const [byEvent, byExperiment, traceless, combined] = await Promise.all([
    listProjectEvents(PROJECT_ID, { eventName: "COMPARISON" }, db),
    listProjectEvents(PROJECT_ID, { experiment: "ranking" }, db),
    listProjectEvents(PROJECT_ID, { tracelessOnly: true }, db),
    listProjectEvents(
      PROJECT_ID,
      {
        eventName: "comparison",
        experiment: "ranking",
        tracelessOnly: true,
      },
      db,
    ),
  ]);

  assert.deepEqual(
    {
      byEvent: byEvent.items.map(({ id }) => id),
      byExperiment: byExperiment.items.map(({ id }) => id),
      traceless: traceless.items.map(({ id }) => id),
      combined: combined.items.map(({ id }) => id),
    },
    {
      byEvent: [uuid(82), uuid(81)],
      byExperiment: [uuid(83), uuid(81), uuid(80)],
      traceless: [uuid(83), uuid(81)],
      combined: [uuid(81)],
    },
  );
  await client.close();
});

test("listProjectEvents uses inclusive since and exclusive until bounds", async () => {
  const { client, db } = await setup();
  await insertOtelLogs(
    PROJECT_ID,
    [
      otelLog({
        id: uuid(90),
        occurredAt: new Date("2026-07-30T09:59:59.999Z"),
      }),
      otelLog({
        id: uuid(91),
        occurredAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      otelLog({
        id: uuid(92),
        occurredAt: new Date("2026-07-30T10:30:00.000Z"),
      }),
      otelLog({
        id: uuid(93),
        occurredAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ],
    db,
  );

  const page = await listProjectEvents(
    PROJECT_ID,
    {
      since: new Date("2026-07-30T10:00:00.000Z"),
      until: new Date("2026-07-30T11:00:00.000Z"),
    },
    db,
  );

  assert.deepEqual(
    page.items.map(({ id }) => id),
    [uuid(92), uuid(91)],
  );
  await client.close();
});

test("listProjectEvents clamps page size and defaults to fifty events", async () => {
  const { client, db } = await setup();
  await insertOtelLogs(
    PROJECT_ID,
    Array.from({ length: 101 }, (_, index) =>
      otelLog({
        id: uuid(1_000 + index),
        occurredAt: new Date(Date.parse("2026-07-30T10:00:00.000Z") + index),
      }),
    ),
    db,
  );

  const [minimum, maximum, defaulted] = await Promise.all([
    listProjectEvents(PROJECT_ID, { limit: 0 }, db),
    listProjectEvents(PROJECT_ID, { limit: 1_000 }, db),
    listProjectEvents(PROJECT_ID, {}, db),
  ]);

  assert.deepEqual(
    {
      minimum: {
        count: minimum.items.length,
        hasMore: minimum.hasMore,
        hasCursor: minimum.nextCursor !== null,
      },
      maximum: {
        count: maximum.items.length,
        hasMore: maximum.hasMore,
        hasCursor: maximum.nextCursor !== null,
      },
      defaulted: {
        count: defaulted.items.length,
        hasMore: defaulted.hasMore,
        hasCursor: defaulted.nextCursor !== null,
      },
    },
    {
      minimum: { count: 1, hasMore: true, hasCursor: true },
      maximum: { count: 100, hasMore: true, hasCursor: true },
      defaulted: { count: 50, hasMore: true, hasCursor: true },
    },
  );
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

function otelLog(overrides: Partial<NewOtelLog> = {}): NewOtelLog {
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    occurredAt: new Date("2026-07-30T10:00:00.000Z"),
    eventName: "ratel.experiment.results",
    traceId: traceId(1),
    spanId: spanId(1),
    severityNumber: 9,
    serviceName: "fixture-agent",
    scopeName: "@ratel-ai/sdk",
    body: null,
    experimentName: "ranking-v2",
    experimentArm: "candidate",
    experimentRole: "shadow",
    experimentSelectionId: "selection-1",
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
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
