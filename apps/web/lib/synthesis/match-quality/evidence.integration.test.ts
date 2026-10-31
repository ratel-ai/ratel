import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { projects } from "@/lib/platform/projects/schema";
import { loadInvokedToolsBySearchId, observeRetrieval } from "./evidence";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "44444444-4444-4444-8444-444444444444";
const AT = new Date("2026-09-10T12:00:00Z");
const WINDOW = {
  since: new Date("2026-09-03T12:00:00Z"),
  until: new Date("2026-09-10T13:00:00Z"),
};

async function seeded() {
  const client = await createMigratedPGlite();
  // Cast once, here. PGlite and node-postgres expose an identical query surface
  // and differ only in the driver metadata on a result, so every `lib/` helper
  // works against this handle; casting at each of the forty call sites instead
  // would bury that fact in noise.
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Org", slug: "org" });
  await db.insert(projects).values([
    { id: PROJECT, organizationId: ORG, name: "P", slug: "p" },
    { id: OTHER, organizationId: ORG, name: "Q", slug: "q" },
  ]);
  return { client, db };
}

let eventSeq = 0;
function traceEvent(over: Partial<typeof traceEvents.$inferInsert> = {}) {
  eventSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(eventSeq).padStart(12, "0")}`,
    projectId: PROJECT,
    type: "invoke_end",
    occurredAt: AT,
    clientEventId: `c-${eventSeq}`,
    payload: {},
    ...over,
  };
}

test("an invoked tool is joined to its search through search_id", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db
    .insert(traceEvents)
    .values([
      traceEvent({ searchId: "sel-1", toolId: "refund_payment" }),
      traceEvent({ searchId: "sel-2", toolId: "list_invoices", type: "invoke_start" }),
    ]);

  const found = await loadInvokedToolsBySearchId(PROJECT, ["sel-1", "sel-2"], WINDOW, db);
  assert.equal(found.get("sel-1"), "refund_payment");
  assert.equal(found.get("sel-2"), "list_invoices");
});

test("the earliest invocation wins, so a later step is not mistaken for the answer", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db.insert(traceEvents).values([
    traceEvent({
      searchId: "sel-1",
      toolId: "second_step",
      occurredAt: new Date(AT.getTime() + 30_000),
    }),
    traceEvent({ searchId: "sel-1", toolId: "first_step", occurredAt: AT }),
  ]);

  const found = await loadInvokedToolsBySearchId(PROJECT, ["sel-1"], WINDOW, db);
  assert.equal(found.get("sel-1"), "first_step");
});

test("an invocation just past the window edge is still joined to its search", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  // A search at the very end of the window is followed by its invoke seconds
  // later, which lands outside it. Bounding the read by the window would drop
  // exactly the most recent evidence.
  await db.insert(traceEvents).values([
    traceEvent({
      searchId: "sel-1",
      toolId: "refund_payment",
      occurredAt: new Date(WINDOW.until.getTime() + 60_000),
    }),
  ]);

  const found = await loadInvokedToolsBySearchId(PROJECT, ["sel-1"], WINDOW, db);
  assert.equal(found.get("sel-1"), "refund_payment");
});

test("an invocation an hour past the window is a different session, not a follow-through", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db.insert(traceEvents).values([
    traceEvent({
      searchId: "sel-1",
      toolId: "refund_payment",
      occurredAt: new Date(WINDOW.until.getTime() + 2 * 60 * 60 * 1000),
    }),
  ]);

  const found = await loadInvokedToolsBySearchId(PROJECT, ["sel-1"], WINDOW, db);
  assert.equal(found.size, 0);
});

test("non-invoke events and another project's rows never leak in", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db
    .insert(traceEvents)
    .values([
      traceEvent({ searchId: "sel-1", toolId: "searched", type: "search" }),
      traceEvent({ searchId: "sel-1", toolId: "not_ours", projectId: OTHER }),
      traceEvent({ searchId: "sel-2", toolId: null }),
    ]);

  const found = await loadInvokedToolsBySearchId(PROJECT, ["sel-1", "sel-2"], WINDOW, db);
  assert.equal(found.size, 0);
});

test("an empty search-id list does not query at all", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());
  assert.equal((await loadInvokedToolsBySearchId(PROJECT, [], WINDOW, db)).size, 0);
});

test("retrieval stages are read from the preserved search payload", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db.insert(traceEvents).values([
    traceEvent({ type: "search", topK: 5, payload: { stages: ["bm25", "dense", "rrf"] } }),
    traceEvent({ type: "search", topK: 5, payload: { stages: ["bm25", "dense", "rrf"] } }),
    traceEvent({ type: "search", topK: 5, payload: { stages: ["bm25"] } }),
    // Not a search, so it contributes nothing.
    traceEvent({ type: "invoke_end", payload: { stages: ["nonsense"] } }),
  ]);

  const observed = await observeRetrieval(PROJECT, WINDOW, db);
  assert.deepEqual(observed.stages, ["bm25", "dense", "rrf"]);
  assert.equal(observed.topK, 5);
  assert.equal(observed.samples, 3);
});

test("a project whose SDK reports no stages gets an absence, not a default", async (t) => {
  const { client, db } = await seeded();
  t.after(() => client.close());

  await db
    .insert(traceEvents)
    .values([traceEvent({ type: "search", topK: 8, payload: { took_ms: 3 } })]);

  const observed = await observeRetrieval(PROJECT, WINDOW, db);
  assert.deepEqual(observed.stages, []);
  assert.equal(observed.samples, 0);
  assert.equal(observed.topK, 8);
});
