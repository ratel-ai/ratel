import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { otlpRawExports } from "@/lib/ingest/otlp-raw/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { pruneExpiredOtlpRawExports } from "@/lib/synthesis/traces/queries";
import { createOtlpRawStore, type OtlpRawStoreDb, readOtlpRawExportPage } from "./store";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("a stored body gunzips back to the same bytes", async () => {
  const { db } = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  const body = new TextEncoder().encode("resourceSpans ".repeat(200));

  const result = await store.store({
    projectId: PROJECT_ID,
    signal: "traces",
    contentType: "application/x-protobuf",
    body,
    gzipped: new Uint8Array(gzipSync(body)),
    itemCount: 3,
    traceIds: ["aa", "bb"],
  });

  assert.equal(result.stored, true);
  const [row] = await db.select().from(otlpRawExports);
  assert.deepEqual(new Uint8Array(gunzipSync(row.body)), body);
  assert.equal(row.projectId, PROJECT_ID);
  assert.equal(row.signal, "traces");
  assert.equal(row.contentType, "application/x-protobuf");
  assert.equal(row.rawBytes, body.byteLength);
  assert.equal(row.storedBytes, row.body.byteLength);
  assert.equal(row.itemCount, 3);
  assert.deepEqual(row.traceIds, ["aa", "bb"]);
  assert.equal(result.stored && result.storedBytes, row.storedBytes);
});

test("an uncompressed body is gzipped before it is stored", async () => {
  const { db } = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  const body = new TextEncoder().encode('{"resourceLogs":[]}'.repeat(100));

  await store.store({
    projectId: PROJECT_ID,
    signal: "logs",
    contentType: "application/json",
    body,
    itemCount: 0,
    traceIds: [],
  });

  const [row] = await db.select().from(otlpRawExports);
  assert.deepEqual(new Uint8Array(gunzipSync(row.body)), body);
  assert.ok(row.storedBytes < row.rawBytes);
});

test("a project over its daily cap is skipped and gets no row", async () => {
  const { db } = await setup();
  const body = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
  const storedSize = gzipSync(body).byteLength;
  const store = createOtlpRawStore({
    db,
    dailyCapBytes: storedSize * 2,
    now: () => NOW,
  });
  const input = {
    projectId: PROJECT_ID,
    signal: "traces" as const,
    contentType: "application/x-protobuf",
    body,
    itemCount: 1,
    traceIds: ["aa"],
  };

  assert.equal((await store.store(input)).stored, true);
  assert.equal((await store.store(input)).stored, true);
  const third = await store.store(input);

  assert.deepEqual(third, {
    stored: false,
    skipped: "over_daily_cap",
    rawBytes: body.byteLength,
    storedBytes: storedSize,
    usedBytes: storedSize * 2,
    capBytes: storedSize * 2,
  });
  assert.equal(await countRows(db, PROJECT_ID), 2);
  // The cap is per project.
  assert.equal((await store.store({ ...input, projectId: OTHER_PROJECT_ID })).stored, true);
});

test("the daily cap counts only today's UTC bytes", async () => {
  const { db } = await setup();
  const body = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
  const storedSize = gzipSync(body).byteLength;
  const input = {
    projectId: PROJECT_ID,
    signal: "traces" as const,
    contentType: "application/x-protobuf",
    body,
    itemCount: 1,
    traceIds: [],
  };
  const yesterday = createOtlpRawStore({
    db,
    dailyCapBytes: storedSize,
    now: () => new Date(NOW.getTime() - DAY_MS),
  });
  const today = createOtlpRawStore({ db, dailyCapBytes: storedSize, now: () => NOW });

  assert.equal((await yesterday.store(input)).stored, true);
  assert.equal((await today.store(input)).stored, true);
  assert.equal((await today.store(input)).stored, false);
});

test("prune deletes only rows past retention, one bounded batch at a time", async () => {
  const { client, db } = await setup();
  await client.exec(`
    insert into otlp_raw_exports
      (id, project_id, received_at, signal, content_type, body, raw_bytes, stored_bytes, item_count, trace_ids)
    values
      ('00000000-0000-4000-8000-000000000001', '${PROJECT_ID}', '2026-10-01T00:00:00Z', 'traces', 'x', '\\x00', 1, 1, 1, '{}'),
      ('00000000-0000-4000-8000-000000000002', '${OTHER_PROJECT_ID}', '2026-10-02T00:00:00Z', 'logs', 'x', '\\x00', 1, 1, 1, '{}'),
      ('00000000-0000-4000-8000-000000000003', '${PROJECT_ID}', '2026-10-03T00:00:00Z', 'traces', 'x', '\\x00', 1, 1, 1, '{}'),
      ('00000000-0000-4000-8000-000000000004', '${PROJECT_ID}', '2026-11-01T00:00:00Z', 'traces', 'x', '\\x00', 1, 1, 1, '{}');
  `);
  const options = { now: NOW, retentionDays: 30, batchSize: 2 };

  assert.equal(await pruneExpiredOtlpRawExports(options, db), 2);
  assert.deepEqual(await remainingIds(db), [
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
  ]);
  assert.equal(await pruneExpiredOtlpRawExports(options, db), 1);
  assert.equal(await pruneExpiredOtlpRawExports(options, db), 0);
  assert.deepEqual(await remainingIds(db), ["00000000-0000-4000-8000-000000000004"]);
});

test("a failed insert throws without the body or the query params", async () => {
  const { db } = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  const body = new TextEncoder().encode("PRIVATE user prompt");
  const stored = gzipSync(body);

  const error = await store
    .store({
      projectId: "44444444-4444-4444-8444-444444444444",
      signal: "traces",
      contentType: "application/json",
      body,
      itemCount: 1,
      traceIds: ["private-trace"],
    })
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

  assert.ok(error instanceof Error);
  assert.equal(error.message, "otlp raw insert failed");
  assert.equal((error as Error & { code?: string }).code, "23503");
  const printed = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error.stack);
  assert.ok(!printed.includes("params"), printed);
  assert.ok(!printed.includes("private-trace"), printed);
  assert.ok(!printed.includes(Array.from(stored.subarray(10, 20)).join(",")), printed);
  assert.equal(error.cause, undefined);
});

test("deleting a project deletes its raw exports", async () => {
  const { client, db } = await setup();
  const store = createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: () => NOW });
  const input = {
    signal: "traces" as const,
    contentType: "application/x-protobuf",
    body: new Uint8Array([1, 2, 3]),
    itemCount: 1,
    traceIds: [],
  };
  await store.store({ ...input, projectId: PROJECT_ID });
  await store.store({ ...input, projectId: OTHER_PROJECT_ID });

  await client.exec(`delete from projects where id = '${PROJECT_ID}'`);

  assert.equal(await countRows(db, PROJECT_ID), 0);
  assert.equal(await countRows(db, OTHER_PROJECT_ID), 1);
});

test("pages read one project's bodies in its window, oldest first", async () => {
  const { db } = await setup();
  const input = {
    signal: "traces" as const,
    contentType: "application/json",
    itemCount: 1,
    traceIds: [],
  };
  const at = (hour: number) => () =>
    new Date(`2026-11-09T${String(hour).padStart(2, "0")}:00:00.000Z`);
  for (const hour of [1, 2, 3, 4]) {
    await createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: at(hour) }).store({
      ...input,
      projectId: PROJECT_ID,
      body: new TextEncoder().encode(`body-${hour}`),
    });
  }
  await createOtlpRawStore({ db, dailyCapBytes: 10_000_000, now: at(2) }).store({
    ...input,
    projectId: OTHER_PROJECT_ID,
    body: new TextEncoder().encode("other"),
  });
  const window = {
    projectId: PROJECT_ID,
    since: at(2)(),
    until: at(4)(),
    limit: 1,
  };

  const first = await readOtlpRawExportPage(db, window);
  const second = await readOtlpRawExportPage(db, { ...window, after: first[0] });
  const third = await readOtlpRawExportPage(db, { ...window, after: second[0] });

  const text = (rows: typeof first) =>
    rows.map((row) => new TextDecoder().decode(gunzipSync(row.body)));
  assert.deepEqual([...text(first), ...text(second)], ["body-2", "body-3"]);
  assert.deepEqual(third, []);
});

type TestDb = OtlpRawStoreDb & Parameters<typeof pruneExpiredOtlpRawExports>[1];

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
  return { client, db: drizzle(client, { schema }) as unknown as TestDb };
}

async function countRows(db: TestDb, projectId: string): Promise<number> {
  const rows = await db
    .select({ id: otlpRawExports.id })
    .from(otlpRawExports)
    .where(eq(otlpRawExports.projectId, projectId));
  return rows.length;
}

async function remainingIds(db: TestDb): Promise<string[]> {
  const rows = await db
    .select({ id: otlpRawExports.id })
    .from(otlpRawExports)
    .orderBy(asc(otlpRawExports.id));
  return rows.map((row) => row.id);
}
