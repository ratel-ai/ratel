import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { LOCAL_ORGANIZATION_ID } from "@/lib/adapters/oss/session";
import { runStep, seedTaskLoop } from "@/lib/console/seed/task-loop";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { jobs } from "@/lib/jobs/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { projects } from "@/lib/platform/projects/schema";
import { traceSignalRuns, traceSignals } from "@/lib/readings/trace-signals/schema";
import { latestFixDraft } from "@/lib/views/fix-drafts/store";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";
import { taskShipmentsFor } from "@/lib/views/task-evals/post-ship";
import { taskEvalRuns } from "@/lib/views/task-evals/schema";
import { taskEvalSetFor } from "@/lib/views/task-evals/store";
import { dailyScoresFor } from "@/lib/views/task-scorers/store";

/**
 * The task loop demo seed against a migrated PGlite. Owned (ADR-0030): upstream's
 * `scripts/seed-task-loop.test.mts`, here beside the seed so the package's test glob runs it.
 * The organization is the edition's local one (the session port answers only for it), with no
 * plan column.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = LOCAL_ORGANIZATION_ID;
const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;

test("model-free seeding writes scores, evals, a draft, simulations and a measured shipment", async () => {
  const { client, db } = await demoDb();
  try {
    const [top, older] = demoFixes();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Model-free seeding must not make an HTTP request.");
    };
    let result: Awaited<ReturnType<typeof seedTaskLoop>>;
    try {
      result = await seedTaskLoop(db, "demo", {
        now: NOW,
        noModels: true,
        loadFixes: async () => [top, older],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(result.taskId, "task-a");
    assert.equal(result.fixId, top.id);
    assert.equal(
      new Set((await dailyScoresFor(PROJECT, "task-a", db)).map((row) => row.day)).size,
      14,
    );
    assert.ok((await taskEvalSetFor(PROJECT, "task-a", db)).cases.length >= 20);
    assert.equal((await latestFixDraft(PROJECT, top.id, db))?.status, "ready");
    const shipments = await taskShipmentsFor(PROJECT, "task-a", db);
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0]!.fixId, older.id);
    assert.equal(shipments[0]!.status, "completed");
    assert.ok(shipments[0]!.nRuns > 0);
    assert.ok(shipments[0]!.comparison?.ends_well.predicted);
    assert.deepEqual(result.urls.slice(0, 4), [
      `http://localhost:3000/project/${PROJECT}/tasks`,
      `http://localhost:3000/project/${PROJECT}/tasks/task-a`,
      `http://localhost:3000/project/${PROJECT}/tasks/task-a/simulations`,
      `http://localhost:3000/project/${PROJECT}/tasks/task-a/simulations/issue%3Atop`,
    ]);
    const runs = await db.select().from(taskEvalRuns);
    assert.ok(
      runs.filter((row) => row.kind === "simulation").every((row) => row.status === "completed"),
    );
    assert.ok(runs.every((row) => Number(row.spend?.usd ?? 0) === 0));
    const rows = await db.select().from(jobs);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.status === "done"));
  } finally {
    await client.close();
  }
});

test("an explicit job payload does not claim an unrelated queued draft", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await db.insert(organizations).values({ id: ORG, name: "Test", slug: "test" });
    await db
      .insert(projects)
      .values({ id: PROJECT, organizationId: ORG, name: "Demo", slug: "demo" });
    const [unrelated] = await db
      .insert(jobs)
      .values({ projectId: PROJECT, kind: "draft_fix", payload: { fixId: "other" } })
      .returning();
    const result = await runStep(
      db,
      PROJECT,
      "draft_fix",
      async (job) => {
        assert.deepEqual(job.payload, { fixId: "chosen" });
        return { status: "ready" };
      },
      { payload: { fixId: "chosen" } },
    );
    assert.equal(result.status, "done");
    const rows = await db.select().from(jobs);
    assert.equal(rows.find((job) => job.id === unrelated!.id)!.status, "queued");
  } finally {
    await client.close();
  }
});

test("stored project fixes seed the demo and repeated runs reuse the shipment", async () => {
  const { client, db } = await demoDb();
  try {
    await db.insert(runtimeCatalogEntries).values({
      projectId: PROJECT,
      kind: "tool",
      entryId: "track_parcel",
      name: "track_parcel",
      description: "Track a parcel.",
      searchableDescription: "Track a parcel.",
      searchableDescriptionOverridden: false,
      contentHash: "parcel",
    });
    await db.insert(traceSignalRuns).values({
      projectId: PROJECT,
      trigger: "manual",
      status: "completed",
      windowDays: 30,
      windowStart: new Date(NOW.getTime() - 30 * DAY),
      windowEnd: NOW,
      finishedAt: NOW,
      summary: {
        version: 1,
        daily: [],
        coveredFrom: "2026-10-03",
        flow: { nodes: [], edges: [] },
        workflows: {
          version: 1,
          items: [
            {
              id: "task-a",
              coreTools: ["lookup_order", "track_parcel"],
              typicalOrder: ["lookup_order", "track_parcel"],
              runs: 42,
            },
          ],
        },
      },
    });
    for (const [position, tool] of ["lookup_order", "track_parcel"].entries()) {
      await db.insert(traceSignals).values({
        projectId: PROJECT,
        kind: "first_try_miss",
        subjectKind: "tool",
        subjectKey: tool,
        subject: { ids: [tool] },
        severity: 0.8 - position * 0.1,
        impact: 10,
        n: 12,
        metrics: { route: "rewrite_description" },
        evidence: {},
        firstSeenAt: new Date(NOW.getTime() - (10 + position) * DAY),
        lastSeenAt: NOW,
      });
    }
    const first = await seedTaskLoop(db, PROJECT, { now: NOW, noModels: true });
    const second = await seedTaskLoop(db, "demo", { now: NOW, noModels: true });
    assert.equal(first.taskId, "task-a");
    assert.equal(second.shipmentId, first.shipmentId);
    assert.equal((await taskShipmentsFor(PROJECT, "task-a", db)).length, 1);
  } finally {
    await client.close();
  }
});

test("a repeat seed refuses a shipment with no measured runs", async () => {
  const { client, db } = await demoDb(16);
  const fixes = demoFixes();
  try {
    const run = () =>
      seedTaskLoop(db, PROJECT, { now: NOW, noModels: true, loadFixes: async () => fixes });
    await assert.rejects(run, /recorded runs after the shipment date/);
    await assert.rejects(run, /recorded runs after the shipment date/);
  } finally {
    await client.close();
  }
});

function demoFixes(): [Fix, Fix] {
  const base = buildFixes(fixesInput()).open.find((fix) => fix.source === "rewrite")!;
  const top: Fix = {
    ...base,
    id: "issue:top",
    source: "issue",
    sourceId: "top",
    aliases: [],
    issues: [],
    subject: {
      ...base.subject,
      tasks: [{ id: "task-a", label: "Check order", href: "", color: null }],
    },
    detail: { source: "issue", changes: ["Explain when to find an order."], caveat: null },
  };
  const older: Fix = {
    ...base,
    id: "rewrite:older",
    appliedAt: "2026-10-20T12:00:00Z",
    subject: top.subject,
  };
  return [top, older];
}

async function demoDb(shiftDays = 0) {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await db.insert(organizations).values({ id: ORG, name: "Test", slug: "test" });
  await db
    .insert(projects)
    .values({ id: PROJECT, organizationId: ORG, name: "Demo", slug: "demo" });
  await db.insert(runtimeCatalogEntries).values({
    projectId: PROJECT,
    kind: "tool",
    entryId: "lookup_order",
    name: "lookup_order",
    description: "Fetch a purchase record.",
    searchableDescription: "Fetch a purchase record.",
    searchableDescriptionOverridden: false,
    contentHash: "demo",
  });
  for (let day = 0; day < 14; day++) {
    for (let n = 0; n < 3; n++) {
      const at = new Date(NOW.getTime() - (day + shiftDays) * DAY - 60_000 * (n + 1));
      const id = randomUUID();
      await db.insert(traceTurns).values({
        id,
        projectId: PROJECT,
        workflowId: "task-a",
        sessionId: id,
        turnKey: id,
        turnSource: "declared",
        lane: "runtime",
        status: "closed",
        startedAt: at,
        endedAt: at,
        lastReceivedAt: at,
      });
      await db.insert(traceTurnSteps).values({
        projectId: PROJECT,
        turnId: id,
        traceEventId: randomUUID(),
        ordinal: 1,
        kind: "invoke",
        eventType: "invoke_end",
        occurredAt: at,
        receivedAt: at,
        targetType: "tool",
        targetId: "lookup_order",
        outcome: n === 0 ? "error" : "ok",
      });
    }
  }
  return { client, db };
}
