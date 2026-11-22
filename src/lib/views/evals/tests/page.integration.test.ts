import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { traceWorkflowLabels } from "@/lib/readings/trace-signals/schema";
import { evals } from "@/lib/views/evals/schema";
import { runScores, scorers } from "@/lib/views/scorers/schema";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import {
  loadEvalDefinition,
  loadEvalPage,
  loadEvalRunsPage,
  loadEvalsPage,
  loadRunPage,
  loadRunsPage,
  loadTaskEvals,
} from "../page";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const FLAGS_OFF: OrganizationFlagDeps = { ...FLAGS_ON, evaluate: async () => false };
// Distinct asks per run, so two score-based suggestions are not near-duplicates (RC-616).
const loadAsks = async (_p: string, ids: readonly string[]) =>
  new Map(ids.map((id) => [id, `Where is my refund ${id}?`]));

test("flag off: every Evals page reads as missing and nothing is imported or suggested", async () => {
  const { client, db } = await setup();
  try {
    const deps = { db, flagDeps: FLAGS_OFF, loadAsks };
    assert.equal(await loadEvalsPage(PROJECT, "user_1", null, deps), null);
    assert.equal(await loadRunsPage(PROJECT, "user_1", deps), null);
    assert.equal(await loadRunPage(PROJECT, "user_1", randomUUID(), "all", deps), null);
    assert.equal((await db.select().from(evals)).length, 0);
  } finally {
    await client.close();
  }
});

test("flag on: the first open imports pinned cases and suggests low-scoring runs; runs and one run's table read back", async () => {
  const { client, db } = await setup();
  try {
    const deps = { db, flagDeps: FLAGS_ON, loadAsks };
    await db
      .insert(traceWorkflowLabels)
      .values({ projectId: PROJECT, workflowId: "wf-1", inputHash: "h", name: "Refund status" });
    const page = (await loadEvalsPage(PROJECT, "user_1", null, deps))!;
    assert.equal(page.evalCount, 3, "The two suggestions join the set at once.");
    assert.deepEqual(page.tasks, [{ id: "wf-1", label: "Refund status" }]);
    assert.equal(page.suggestedCount, 2);
    assert.deepEqual(page.rows.map((row) => row.suggested).sort(), [false, true, true]);
    assert.deepEqual(page.rows[0]!.tasks, [{ id: "wf-1", label: "Refund status" }]);
    assert.equal(
      (await loadEvalsPage(PROJECT, "user_1", null, deps))!.evalCount,
      3,
      "A second open imports nothing again.",
    );
    assert.equal((await loadEvalsPage(PROJECT, "user_1", "wf-9", deps))!.rows.length, 0);

    const store = createDrizzleEvalStore(db);
    const run = await store.createRun({
      projectId: PROJECT,
      kind: "manual",
      createdBy: "t",
      suite: "All evals",
      evalCount: 1,
    });
    await store.recordResults(PROJECT, run.id, [
      {
        evalId: page.rows[0]!.id,
        passed: false,
        change: "now_fails",
        verdicts: [
          { kind: "ends_well", status: "fail", measured: null, limit: null, detail: "ends badly" },
        ],
      },
    ]);
    await store.updateRun(PROJECT, run.id, { status: "completed" });
    const runs = (await loadRunsPage(PROJECT, "user_1", deps))!;
    assert.deepEqual(runs.runs[0]!.summary, { passed: 0, total: 1, nowFails: 1, fixed: 0 });
    const one = (await loadRunPage(PROJECT, "user_1", run.id, "failing", deps))!;
    assert.deepEqual(one.table.columns, ["ends_well"]);
    assert.equal(one.table.rows[0]!.cells.ends_well, "fail");
    assert.equal(one.table.rows[0]!.tasks[0]!.label, "Refund status");
    assert.equal(await loadRunPage(PROJECT, "user_1", "not-a-uuid", "all", deps), null);
  } finally {
    await client.close();
  }
});

test("one eval: its last completed run by default, a given run with its place in the run table, and nothing with the flag off", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const deps = { db, flagDeps: FLAGS_ON, loadAsks };
    const evals = [];
    for (const name of ["Charlie", "Alpha", "Bravo"])
      evals.push(
        await store.createEval({
          projectId: PROJECT,
          name,
          message: name,
          origin: "user",
          createdBy: "t",
          status: "approved",
          tasks: ["wf-1"],
          sourceTurnId: randomUUID(),
        }),
      );
    const done = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    await store.recordResults(
      PROJECT,
      done.id,
      evals.map((item) => ({ evalId: item.id, passed: true, verdicts: [] })),
    );
    await store.updateRun(PROJECT, done.id, { status: "completed" });
    const live = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    await store.recordResults(PROJECT, live.id, [
      { evalId: evals[2]!.id, passed: false, verdicts: [] },
    ]);
    const bravo = evals[2]!.id;
    const last = (await loadEvalPage(PROJECT, "user_1", bravo, null, deps))!;
    assert.equal(last.run!.id, done.id, "The default is the newest completed run.");
    assert.equal(last.position, null);
    assert.equal(last.runCount, 2);
    assert.match(last.replayHref!, /\/traces\/turns\//);
    const inRun = (await loadEvalPage(PROJECT, "user_1", bravo, done.id, deps))!;
    assert.deepEqual(
      inRun.position,
      { index: 2, total: 3, prev: evals[1]!.id, next: evals[0]!.id },
      "Alpha, Bravo, Charlie: the run table's order.",
    );
    assert.equal((await loadEvalRunsPage(PROJECT, "user_1", bravo, deps))!.history.length, 2);
    assert.equal((await loadEvalDefinition(PROJECT, "user_1", bravo, deps))!.item.name, "Bravo");
    const off = { ...deps, flagDeps: FLAGS_OFF };
    assert.equal(await loadEvalPage(PROJECT, "user_1", bravo, null, off), null);
    assert.equal(await loadEvalRunsPage(PROJECT, "user_1", bravo, off), null);
    assert.equal(await loadEvalDefinition(PROJECT, "user_1", bravo, off), null);
    assert.equal(await loadEvalPage(PROJECT, "user_1", randomUUID(), null, deps), null);
  } finally {
    await client.close();
  }
});

test("RC-642: one eval at a run reads its previous completed run, and a run still queued reads as pending", async () => {
  const { client, db } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const deps = { db, flagDeps: FLAGS_ON, loadAsks };
    const item = await store.createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "Seat",
      origin: "user",
      createdBy: "t",
      status: "approved",
    });
    const runOf = async (passed: boolean, at: Date) => {
      const run = await store.createRun({
        projectId: PROJECT,
        kind: "manual",
        createdBy: "t",
        createdAt: at,
      });
      await store.recordResults(PROJECT, run.id, [{ evalId: item.id, passed, verdicts: [] }]);
      await store.updateRun(PROJECT, run.id, { status: "completed" });
      return run;
    };
    const first = await runOf(true, new Date("2026-11-13T10:00:00Z"));
    const second = await runOf(false, new Date("2026-11-13T11:00:00Z"));
    const atSecond = (await loadEvalPage(PROJECT, "user_1", item.id, second.id, deps))!;
    assert.equal(atSecond.previous!.run.id, first.id);
    assert.equal(atSecond.previous!.result.passed, true);
    assert.equal(atSecond.pending, null);
    assert.equal(
      (await loadEvalPage(PROJECT, "user_1", item.id, first.id, deps))!.previous,
      null,
      "The first run has none before it.",
    );
    const queued = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "t" });
    const waiting = (await loadEvalPage(PROJECT, "user_1", item.id, queued.id, deps))!;
    assert.equal(waiting.pending!.id, queued.id);
    assert.equal(waiting.result, null);
  } finally {
    await client.close();
  }
});

test("RC-317: a task page lists its evals (suggestions included) with their last result and change, and the live run that covers it", async () => {
  const { client, db } = await setup();
  try {
    const deps = { db, flagDeps: FLAGS_ON, loadAsks };
    assert.equal(
      await loadTaskEvals(PROJECT, "user_1", "wf-1", { ...deps, flagDeps: FLAGS_OFF }),
      null,
    );
    const store = createDrizzleEvalStore(db);
    await store.createEval({
      projectId: PROJECT,
      name: "Other task",
      message: "m",
      origin: "user",
      createdBy: "t",
      status: "approved",
      tasks: ["wf-2"],
    });
    const first = (await loadTaskEvals(PROJECT, "user_1", "wf-1", deps))!;
    assert.equal(
      first.rows.length,
      3,
      "Opening the task fills the set: the pinned case and two suggestions.",
    );
    assert.equal(first.rows.filter((row) => row.suggested).length, 2);
    assert.ok(first.rows.every((row) => row.last === null && row.change === null));
    assert.equal(first.live, null);

    const run = await store.createRun({
      projectId: PROJECT,
      kind: "manual",
      createdBy: "t",
      suite: "Task wf-1",
      evalCount: 2,
    });
    await store.recordResults(PROJECT, run.id, [
      { evalId: first.rows[0]!.id, passed: false, change: "now_fails", verdicts: [] },
    ]);
    await store.updateRun(PROJECT, run.id, { status: "completed" });
    const queued = await store.createRun({
      projectId: PROJECT,
      kind: "manual",
      createdBy: "t",
      suite: "Task wf-1",
      evalCount: 2,
    });
    const second = (await loadTaskEvals(PROJECT, "user_1", "wf-1", deps))!;
    const row = second.rows.find((item) => item.id === first.rows[0]!.id)!;
    assert.deepEqual([row.last, row.change], ["fail", "now_fails"]);
    assert.equal(second.live?.id, queued.id);
    assert.equal(
      (await loadTaskEvals(PROJECT, "user_1", "wf-2", deps))!.live,
      null,
      "A run of another task does not cover this one.",
    );
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  await db.insert(taskEvalSets).values({ projectId: PROJECT, taskId: "wf-1", scorerVersion: 1 });
  await db.insert(taskEvalCases).values([
    { projectId: PROJECT, taskId: "wf-1", turnId: randomUUID(), origin: "auto", pinned: true },
    { projectId: PROJECT, taskId: "wf-1", turnId: randomUUID(), origin: "auto" },
    { projectId: PROJECT, taskId: "wf-1", turnId: randomUUID(), origin: "issue" },
  ]);
  // RC-616: with the gate on, suggestions come from low readings: two runs under the scorer's good threshold.
  const [scorer] = await db
    .insert(scorers)
    .values({
      projectId: PROJECT,
      taskId: "wf-1",
      scope: "task",
      name: "Quality",
      kind: "expression",
      createdBy: "t",
      updatedBy: "t",
    })
    .returning();
  await db.insert(runScores).values(
    [0.1, 0.2].map((value) => ({
      projectId: PROJECT,
      scorerId: scorer!.id,
      scorerVersion: scorer!.version,
      turnId: randomUUID(),
      day: "2026-11-01",
      status: "fail" as const,
      value,
      passed: false,
    })),
  );
  return { client, db };
}
