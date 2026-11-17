import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import { insertEventsWithMetrics } from "@/lib/ingest/otlp/queries";
import { toRows } from "@/lib/ingest/otlp/reconstruct";
import { eventMetrics, events } from "@/lib/ingest/otlp/schema";
import { otlpRawExports } from "@/lib/ingest/otlp-raw/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { type ReprocessIngestFlags, rebuildEventRows, reprocessOtlpRawExports } from "./reprocess";
import { applyReprocessPlan, findStoredEvents, type ReprocessDb } from "./reprocess-store";
import { readOtlpRawExportPage } from "./store";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SINCE = new Date("2026-11-01T00:00:00.000Z");
const FLAGS: ReprocessIngestFlags = {
  captureReply: false,
  agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
};

test("apply patches the stored event and its metrics, and a second apply changes nothing", async () => {
  const db = await setup();
  const body = chatExport();
  await db.insert(otlpRawExports).values({
    projectId: PROJECT_ID,
    receivedAt: new Date("2026-11-05T10:00:01.000Z"),
    signal: "traces",
    contentType: "application/json",
    body: new Uint8Array(gzipSync(body)),
    rawBytes: body.byteLength,
    storedBytes: body.byteLength,
    itemCount: 1,
    traceIds: ["0af7651916cd43dd8448eb211c80319c"],
  });
  // Stored before ingest read the semconv aliases (RC-380).
  const ingested = rowsBeforeAliases(decodeOtlp("application/json", body));
  await insertEventsWithMetrics(PROJECT_ID, ingested, db);
  const [before] = await db.select().from(events);
  assert.equal(before.cachedTokens, null);

  const first = await reprocess(db, true);
  assert.equal(first.changedEvents, 1);

  const [after] = await db.select().from(events);
  const [metric] = await db.select().from(eventMetrics).where(eq(eventMetrics.eventId, after.id));
  assert.equal(after.id, before.id);
  assert.equal(after.cachedTokens, 800);
  assert.ok(Number(after.costUsd) < Number(before.costUsd));
  assert.equal(metric.costUsd, after.costUsd);
  assert.equal((await db.select().from(eventMetrics)).length, 1);

  const second = await reprocess(db, true);
  assert.equal(second.changedEvents, 0);
  assert.equal(second.newEvents, 0);
  assert.equal(second.unchangedEvents, 1);
});

test("a dry run leaves the rows as they were", async () => {
  const db = await setup();
  const body = chatExport();
  await db.insert(otlpRawExports).values({
    projectId: PROJECT_ID,
    receivedAt: new Date("2026-11-05T10:00:01.000Z"),
    signal: "traces",
    contentType: "application/json",
    body: new Uint8Array(gzipSync(body)),
    rawBytes: body.byteLength,
    storedBytes: body.byteLength,
    itemCount: 1,
    traceIds: [],
  });

  const report = await reprocess(db, false);

  assert.equal(report.newEvents, 1);
  assert.equal((await db.select().from(events)).length, 0);
});

test("a span id reused in another trace keeps each row on its own trace, and a second apply changes nothing", async () => {
  const db = await setup();
  const first = chatExport({ traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", input: 1000 });
  const second = chatExport({ traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", input: 9000 });
  await storeRawExport(db, first, "2026-11-05T10:00:01.000Z");
  await storeRawExport(db, second, "2026-11-05T10:00:02.000Z");
  // Live ingest keeps the first call: the second has the same span-id dedupe hash and conflicts.
  await insertEventsWithMetrics(
    PROJECT_ID,
    await rebuildEventRows(PROJECT_ID, decodeOtlp("application/json", first), FLAGS),
    db,
  );
  await insertEventsWithMetrics(
    PROJECT_ID,
    await rebuildEventRows(PROJECT_ID, decodeOtlp("application/json", second), FLAGS),
    db,
  );

  const applied = await reprocess(db, true, 1);
  const again = await reprocess(db, true, 1);

  const rows = await db.select().from(events);
  assert.deepEqual(
    rows.map((row) => [row.traceId, row.inputTokens]),
    [["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1000]],
  );
  assert.equal(applied.changedEvents, 0);
  assert.equal(again.changedEvents, 0);
});

async function storeRawExport(db: ReprocessDb, body: Uint8Array, receivedAt: string) {
  await db.insert(otlpRawExports).values({
    projectId: PROJECT_ID,
    receivedAt: new Date(receivedAt),
    signal: "traces",
    contentType: "application/json",
    body: new Uint8Array(gzipSync(body)),
    rawBytes: body.byteLength,
    storedBytes: body.byteLength,
    itemCount: 1,
    traceIds: [],
  });
}

async function reprocess(db: ReprocessDb, apply: boolean, pageSize?: number) {
  return reprocessOtlpRawExports(
    { projectId: PROJECT_ID, since: SINCE, apply, pageSize },
    {
      flags: FLAGS,
      readPage: (after, limit) =>
        readOtlpRawExportPage(db, { projectId: PROJECT_ID, since: SINCE, after, limit }),
      findStoredEvents: (keys) => findStoredEvents(db, PROJECT_ID, keys),
      applyPlan: (plan) => applyReprocessPlan(db, PROJECT_ID, plan),
    },
  );
}

async function setup(): Promise<ReprocessDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return drizzle(client, { schema }) as unknown as ReprocessDb;
}

/** One Anthropic chat span that sends its cache reads under the OpenLLMetry key only. */
function chatExport({
  traceId = "0af7651916cd43dd8448eb211c80319c",
  input = 1000,
} = {}): Uint8Array {
  const startMs = Date.parse("2026-11-05T10:00:00.000Z");
  const attribute = (key: string, value: object) => ({ key, value });
  return new TextEncoder().encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [attribute("service.name", { stringValue: "agent" })] },
          scopeSpans: [
            {
              scope: { name: "opentelemetry.instrumentation.anthropic" },
              spans: [
                {
                  traceId,
                  spanId: "00000000000000a1",
                  name: "chat claude-sonnet-4-5",
                  kind: 3,
                  startTimeUnixNano: `${startMs}000000`,
                  endTimeUnixNano: `${startMs + 1200}000000`,
                  attributes: [
                    attribute("gen_ai.operation.name", { stringValue: "chat" }),
                    attribute("gen_ai.provider.name", { stringValue: "anthropic" }),
                    attribute("gen_ai.request.model", { stringValue: "claude-sonnet-4-5" }),
                    attribute("gen_ai.usage.input_tokens", { intValue: String(input) }),
                    attribute("gen_ai.usage.output_tokens", { intValue: "50" }),
                    attribute("gen_ai.usage.cache_read_input_tokens", { intValue: "800" }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

/** The rows ingest derived before the semconv alias pass. */
function rowsBeforeAliases(spans: ReturnType<typeof decodeOtlp>) {
  normalizeAiSdkSpans(spans);
  return toRows(PROJECT_ID, groupSpans(spans), { captureReply: false });
}
