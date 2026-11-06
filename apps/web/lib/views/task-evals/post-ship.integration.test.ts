import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { jobs } from "@/lib/jobs/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { buildFixes } from "@/lib/views/fixes/build";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import "@/lib/views/task-evals/ship";
import { fixShipmentTasks } from "@/lib/views/fixes/schema";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import { taskShipmentsFor } from "@/lib/views/task-evals/post-ship";
import { taskEvalCases, taskEvalRuns, taskEvalSets } from "@/lib/views/task-evals/schema";
import type { TaskSimulationDeps } from "@/lib/views/task-evals/simulation";
import { simulateTaskEvalJob } from "@/lib/views/task-evals/simulation-job";
import { upsertScorer } from "@/lib/views/task-scorers/store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

test("a shipment queues one measure per distinct task only when the gate is on", async () => {
  const { client, db, deps, fix, input } = await setup();
  try {
    await createFixShipment(input, db, {
      ...deps,
      flagDeps: { FF_EVAL_GATE: "0" },
    });
    assert.equal((await db.select().from(taskEvalRuns)).length, 0);
    assert.equal((await db.select().from(jobs)).length, 0);
    const shipment = await createFixShipment(input, db, deps);
    assert.equal(shipment.liveMarkedBy, input.shippedBy);
    const runs = await db.select().from(taskEvalRuns);
    assert.deepEqual(runs.map((run) => run.taskId).sort(), ["task-a", "task-b"]);
    assert.ok(
      runs.every(
        (run) =>
          run.kind === "post_ship" &&
          run.status === "queued" &&
          run.shipmentId === shipment.id &&
          run.fixId === fix.id &&
          run.scorerVersion === 1,
      ),
    );
    const tasks = await db.select().from(fixShipmentTasks);
    assert.deepEqual(tasks.map((row) => row.taskId).sort(), ["task-a", "task-b"]);
    const queued = await db.select().from(jobs);
    assert.equal(queued.length, 2);
    assert.ok(queued.every((job) => job.kind === "simulate_task_eval"));
  } finally {
    await client.close();
  }
});

test("a measure waits for 20 closed runs without duplicate retries", async () => {
  const { client, db, deps, input } = await setup();
  try {
    const shippedAt = new Date("2026-11-01T00:00:00Z");
    await createFixShipment(input, db, { ...deps, now: () => shippedAt });
    const [run] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.taskId, "task-a"));
    await addRuns(db, "task-a", 19, new Date("2026-11-01T01:00:00Z"));
    await addRuns(db, "task-a", 5, new Date("2026-10-31T23:00:00Z"));
    await addRuns(db, "another-task", 5, new Date("2026-11-01T01:00:00Z"));
    const now = new Date("2026-11-01T02:00:00Z");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(
        await simulateTaskEvalJob(PROJECT, { runId: run!.id }, { ...deps, now: () => now }),
        { simulated: false, reason: "waiting_for_runs", nRuns: 19 },
      );
    }
    const retries = (await db.select().from(jobs)).filter((job) => job.createdAt > now);
    assert.equal(retries.length, 1, "Repeated delivery keeps one scheduled retry.");
    assert.equal(retries[0]!.createdAt.toISOString(), "2026-11-01T03:00:00.000Z");
    await addRuns(db, "task-a", 1, new Date("2026-11-01T01:30:00Z"));
    assert.equal(
      (await simulateTaskEvalJob(PROJECT, { runId: run!.id }, { ...deps, now: () => now }))
        .simulated,
      true,
    );
    const [measured] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run!.id));
    assert.equal(measured!.caseCount, 20);
  } finally {
    await client.close();
  }
});

test("the comparison preserves the simulation baseline and prediction with frozen scorers", async () => {
  const { client, db, deps, input, fix } = await setup();
  try {
    const shippedAt = new Date("2026-11-01T00:00:00Z");
    const before = { passed: 1, total: 4, passRate: 0.25, score: 0.25 };
    const after = { passed: 3, total: 4, passRate: 0.75, score: 0.75 };
    await db.insert(taskEvalRuns).values({
      projectId: PROJECT,
      taskId: "task-a",
      fixId: fix.id,
      scorerVersion: 1,
      status: "completed",
      createdBy: input.shippedBy,
      change: { scorers: [{ kind: "max_tool_calls", max: 0 }] },
      breakdown: { task: { max_tool_calls: { before, after } } },
    });
    const shipment = await createFixShipment(input, db, { ...deps, now: () => shippedAt });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 5 },
        updatedBy: "test",
      },
      db,
    );
    await addRuns(db, "task-a", 20, new Date("2026-11-01T01:00:00Z"));
    const [run] = await db
      .select()
      .from(taskEvalRuns)
      .where(and(eq(taskEvalRuns.kind, "post_ship"), eq(taskEvalRuns.taskId, "task-a")));
    const now = new Date("2026-11-01T02:00:00Z");
    await simulateTaskEvalJob(PROJECT, { runId: run!.id }, { ...deps, now: () => now });
    const markers = await taskShipmentsFor(PROJECT, "task-a", db);
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.id, shipment.id);
    assert.equal(markers[0]!.status, "completed");
    assert.deepEqual(markers[0]!.comparison, {
      max_tool_calls: {
        baseline: before,
        predicted: after,
        actual: { passed: 0, total: 20, passRate: 0, score: 0 },
      },
    });
    assert.equal(
      (await simulateTaskEvalJob(PROJECT, { runId: run!.id }, { ...deps, now: () => now }))
        .simulated,
      true,
    );
    assert.deepEqual(
      await taskShipmentsFor("33333333-3333-4333-8333-333333333333", "task-a", db),
      [],
    );
  } finally {
    await client.close();
  }
});

test("the seven-day cap completes a sparse or empty measure and excludes later runs", async () => {
  const { client, db, deps, input } = await setup();
  try {
    await createFixShipment(input, db, { ...deps, now: () => new Date("2026-11-01T00:00:00Z") });
    await addRuns(db, "task-a", 3, new Date("2026-11-01T01:00:00Z"));
    await addRuns(db, "task-a", 25, new Date("2026-11-08T01:00:00Z"));
    const runs = await db.select().from(taskEvalRuns);
    for (const run of runs) {
      assert.equal(
        (
          await simulateTaskEvalJob(
            PROJECT,
            { runId: run.id },
            { ...deps, now: () => new Date("2026-11-08T00:00:00Z") },
          )
        ).simulated,
        true,
      );
    }
    const measured = await db.select().from(taskEvalRuns);
    assert.deepEqual(measured.map((row) => [row.taskId, row.status, row.caseCount]).sort(), [
      ["task-a", "completed", 3],
      ["task-b", "completed", 0],
    ]);
  } finally {
    await client.close();
  }
});

test("a disabled gate refuses measurement without scoring production runs", async () => {
  const { client, db, deps, input } = await setup();
  try {
    await createFixShipment(input, db, deps);
    const [run] = await db.select().from(taskEvalRuns);
    const off = { ...deps, flagDeps: { FF_EVAL_GATE: "0" } };
    assert.deepEqual(await simulateTaskEvalJob(PROJECT, { runId: run!.id }, off), {
      simulated: false,
      reason: "gate_off",
    });
    const [failed] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run!.id));
    assert.equal(failed!.status, "failed");
    assert.equal(failed!.after, null);
  } finally {
    await client.close();
  }
});

test("a later shipment preserves both markers and replaces the pending observation window", async () => {
  const { client, db, deps, input } = await setup();
  try {
    const first = await createFixShipment(input, db, deps);
    const second = await createFixShipment({ ...input, version: "v3" }, db, deps);
    const markers = await taskShipmentsFor(PROJECT, "task-a", db);
    assert.equal(markers.length, 2);
    assert.equal(markers.find((row) => row.id === first.id)!.status, "failed");
    assert.equal(markers.find((row) => row.id === second.id)!.status, "queued");
    assert.match(markers.find((row) => row.id === first.id)!.error!, /later shipment/);
    const active = (await db.select().from(taskEvalRuns)).filter((row) => row.status === "queued");
    assert.equal(active.length, 2);
    assert.ok(active.every((row) => row.shipmentId === second.id));
  } finally {
    await client.close();
  }
});

test("an unavailable simulation prediction still keeps the measured eval baseline", async () => {
  const { client, db, deps, input, fix } = await setup();
  try {
    await addRuns(db, "task-a", 1, new Date("2026-10-31T01:00:00Z"));
    const [turn] = await db.select().from(traceTurns);
    await db
      .insert(taskEvalSets)
      .values({ projectId: PROJECT, taskId: "task-a", scorerVersion: 1 });
    await db
      .insert(taskEvalCases)
      .values({ projectId: PROJECT, taskId: "task-a", turnId: turn!.id, origin: "auto" });
    const unknown = { passed: 0, total: 0, passRate: null, score: null };
    await db.insert(taskEvalRuns).values({
      projectId: PROJECT,
      taskId: "task-a",
      fixId: fix.id,
      scorerVersion: 1,
      status: "completed",
      createdBy: input.shippedBy,
      change: { scorers: [{ kind: "max_tool_calls", max: 1 }] },
      breakdown: { task: { max_tool_calls: { before: unknown, after: unknown } } },
    });
    await createFixShipment(input, db, { ...deps, now: () => new Date("2026-11-01T00:00:00Z") });
    const [measure] = await db
      .select()
      .from(taskEvalRuns)
      .where(and(eq(taskEvalRuns.kind, "post_ship"), eq(taskEvalRuns.taskId, "task-a")));
    const baseline = measure!.change!.baseline as Record<string, unknown>;
    assert.deepEqual(baseline.max_tool_calls, { passed: 1, total: 1, passRate: 1, score: 1 });
  } finally {
    await client.close();
  }
});

test("post-ship measures judge frozen task criteria and store the model spend", async () => {
  const { client, db, deps, input, fix } = await setup();
  try {
    await db.insert(taskEvalRuns).values({
      projectId: PROJECT,
      taskId: "task-a",
      fixId: fix.id,
      scorerVersion: 1,
      status: "completed",
      createdBy: input.shippedBy,
      change: { scorers: [{ kind: "judge_criteria", criteria: "Frozen criteria." }] },
    });
    await createFixShipment(input, db, { ...deps, now: () => new Date("2026-11-01T00:00:00Z") });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "New criteria." },
        updatedBy: "test",
      },
      db,
    );
    await addRuns(db, "task-a", 20, new Date("2026-11-01T01:00:00Z"));
    const [run] = await db
      .select()
      .from(taskEvalRuns)
      .where(and(eq(taskEvalRuns.kind, "post_ship"), eq(taskEvalRuns.taskId, "task-a")));
    let calls = 0;
    await simulateTaskEvalJob(
      PROJECT,
      { runId: run!.id },
      {
        ...deps,
        now: () => new Date("2026-11-01T02:00:00Z"),
        judgeBudgetUsd: 1,
        models: {
          agent: null,
          tool: null,
          standIn: false,
          judge: {
            model: "claude-sonnet-4-6",
            standIn: false,
            judge: async ({ criteria }) => {
              assert.equal(criteria, "Frozen criteria.");
              calls++;
              return { pass: true, usage: { inputTokens: 100, outputTokens: 10 } };
            },
          },
        },
      },
    );
    const [marker] = await taskShipmentsFor(PROJECT, "task-a", db);
    assert.equal(marker?.comparison?.judge_criteria?.actual.total, 20);
    assert.equal(marker?.comparison?.judge_criteria?.actual.passed, 20);
    assert.ok(calls > 0);
    const [measured] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run!.id));
    assert.ok(Number(measured?.spend?.usd) > 0);
  } finally {
    await client.close();
  }
});

async function addRuns(db: ReturnType<typeof getDb>, taskId: string, n: number, startedAt: Date) {
  for (let i = 0; i < n; i++) {
    const key = randomUUID();
    const [turn] = await db
      .insert(traceTurns)
      .values({
        projectId: PROJECT,
        workflowId: taskId,
        sessionId: key,
        turnKey: key,
        turnSource: "declared",
        lane: "runtime",
        status: "closed",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 1000),
        lastReceivedAt: startedAt,
      })
      .returning();
    await db.insert(traceTurnSteps).values({
      projectId: PROJECT,
      turnId: turn!.id,
      traceEventId: randomUUID(),
      ordinal: 1,
      kind: "invoke",
      eventType: "invoke_end",
      occurredAt: startedAt,
      receivedAt: startedAt,
      targetType: "tool",
      targetId: "lookup",
      outcome: "ok",
    });
  }
}

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Test', 'test');`);
  const original = buildFixes(fixesInput()).open[0]!;
  const fix = {
    ...original,
    subject: {
      ...original.subject,
      tasks: ["task-a", "task-b", "task-a"].map((id) => ({ id, label: id, href: "", color: null })),
    },
  };
  const deps: TaskSimulationDeps = {
    db,
    // Owned (ADR-0030): the gate is the FF_EVAL_GATE env value.
    flagDeps: { FF_EVAL_GATE: "1" },
    loadFix: async () => ({ projectId: PROJECT, fix }),
    observability: { trackSystemEvent: async () => undefined },
  };
  const input = {
    projectId: PROJECT,
    fixId: fix.id,
    insightId: null,
    experimentId: null,
    version: "v2",
    notes: "Test release",
    shippedBy: "project:" + PROJECT,
  };
  return { client, db, deps, fix, input };
}
