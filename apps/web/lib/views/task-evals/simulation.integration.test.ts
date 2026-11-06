import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { jobs } from "@/lib/jobs/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { organizationModelSpendSince, parseResults } from "@/lib/views/eval-gate/store";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";
import { taskEvalCases, taskEvalRuns, taskEvalSets } from "@/lib/views/task-evals/schema";
import { runTaskSimulation, type TaskSimulationDeps } from "@/lib/views/task-evals/simulation";
import { simulateTaskEvalJob } from "@/lib/views/task-evals/simulation-job";
import {
  taskSimulationDetailFor,
  taskSimulationListFor,
} from "@/lib/views/task-evals/simulation-page";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { upsertScorer } from "@/lib/views/task-scorers/store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
// Owned (ADR-0030): the gate is FF_EVAL_GATE from the environment, not an organization flag.
const FLAGS_ON: OrganizationFlagDeps = { FF_EVAL_GATE: "1" };

test("a fix queues one simulation per distinct task and refreshes missing eval sets", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    const result = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    assert.equal(result.status, "queued");
    assert.deepEqual(result.runs.map((run) => run.taskId).sort(), ["task-a", "task-b"]);
    const rows = await db.select().from(taskEvalRuns);
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every(
        (row) => row.fixId === fix.id && row.status === "queued" && row.scorerVersion === 1,
      ),
    );
    const queued = await db.select().from(jobs);
    assert.equal(queued.length, 2);
    assert.ok(queued.every((job) => job.kind === "simulate_task_eval"));
    assert.equal((await db.select().from(taskEvalSets)).length, 2);
    assert.deepEqual((await taskSimulationDetailFor(PROJECT, "task-a", fix, db)).state, {
      state: "running",
      stale: false,
    });
    const again = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    assert.deepEqual(
      again.runs.map((run) => run.id).sort(),
      result.runs.map((run) => run.id).sort(),
    );
    assert.equal((await db.select().from(jobs)).length, 2);
  } finally {
    await client.close();
  }
});

test("the page reads task-scoped history and marks both tasks stale after a shared draft edit", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    await db
      .update(taskEvalRuns)
      .set({ status: "completed", verdict: "better", finishedAt: new Date() });
    await db.insert(taskEvalRuns).values({
      projectId: PROJECT,
      taskId: "task-a",
      fixId: fix.id,
      kind: "post_ship",
      scorerVersion: 1,
      status: "completed",
      verdict: "worse",
      createdBy: "test",
      createdAt: new Date(Date.now() + 1000),
    });
    const list = await taskSimulationListFor(PROJECT, "task-a", [fix], db);
    assert.equal(list.length, 1);
    assert.deepEqual(
      { state: list[0]!.state, stale: list[0]!.stale },
      { state: "better", stale: false },
    );
    await db.insert(fixDrafts).values({
      projectId: PROJECT,
      fixId: fix.id,
      change: { ...emptyChange(), topK: 2 },
      origin: "user",
      status: "ready",
      createdBy: "user_test",
      createdAt: new Date(Date.now() + 1000),
    });
    for (const taskId of ["task-a", "task-b"]) {
      const model = await taskSimulationDetailFor(PROJECT, taskId, fix, db);
      assert.deepEqual(model.state, { state: "better", stale: true });
      assert.equal(
        model.runs.length,
        1,
        "History excludes post-shipment measurements and other tasks.",
      );
      assert.equal(model.change.topK, 2);
      assert.equal(model.runs[0]!.id, queued.runs.find((run) => run.taskId === taskId)!.id);
    }
    assert.deepEqual(
      await taskSimulationListFor("33333333-3333-4333-8333-333333333333", "task-a", [], db),
      [],
    );
  } finally {
    await client.close();
  }
});

test("adding a fix test before the first simulation still initializes the shared task set", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    await seedCases(db, fix.id);
    await db.delete(taskEvalCases).where(isNull(taskEvalCases.fixId));
    await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    const shared = (await db.select().from(taskEvalCases)).filter(
      (row) => row.fixId === null && row.excludedAt === null,
    );
    assert.deepEqual(shared.map((row) => row.taskId).sort(), ["task-a", "task-b"]);
    assert.ok((await db.select().from(taskEvalSets)).every((set) => set.refreshedAt !== null));
  } finally {
    await client.close();
  }
});

test("task simulations report each scorer before and after for task cases and fix cases", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    await seedCases(db, fix.id);
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    for (const run of queued.runs) {
      const result = await simulateTaskEvalJob(PROJECT, { runId: run.id }, deps);
      assert.equal(result.simulated, true);
    }
    const rows = await db.select().from(taskEvalRuns);
    for (const row of rows) {
      assert.equal(row.status, "completed");
      assert.equal(row.caseCount, 1);
      assert.equal(row.fixCaseCount, 1);
      assert.equal(row.scorerVersion, 1);
      const breakdown = row.breakdown as {
        task: Record<
          string,
          { before: { passed: number; total: number }; after: { passed: number; total: number } }
        >;
        fix: Record<string, { before: { passed: number }; after: { passed: number } }>;
      };
      assert.deepEqual(breakdown.task.expected_tool.before, {
        passed: 1,
        total: 1,
        passRate: 1,
        score: 0.8154648767857288,
      });
      assert.deepEqual(breakdown.task.expected_tool.after, {
        passed: 0,
        total: 1,
        passRate: 0,
        score: 0,
      });
      assert.equal(breakdown.fix.expected_tool.before.passed, 1);
      assert.equal(breakdown.fix.expected_tool.after.passed, 0);
      assert.equal(
        breakdown.task.max_tool_calls.before.total,
        0,
        "an unknown after measurement cannot form a pair",
      );
      assert.equal(
        row.results?.length,
        2,
        "another fix and excluded cases do not enter the simulation",
      );
    }
  } finally {
    await client.close();
  }
});

test("the organization flag refuses queue and execution before model calls", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    const off = { ...deps, flagDeps: { FF_EVAL_GATE: "0" } };
    await assert.rejects(
      runTaskSimulation(fix.id, { projectId: PROJECT, deps: off }),
      /eval gate is off/,
    );
    assert.deepEqual(await db.select().from(taskEvalRuns), []);
    assert.deepEqual(await db.select().from(taskEvalSets), []);
    assert.deepEqual(await db.select().from(jobs), []);
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    assert.deepEqual(await simulateTaskEvalJob(PROJECT, { runId: queued.runs[0]!.id }, off), {
      simulated: false,
      reason: "gate_off",
    });
    assert.equal(
      (await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, queued.runs[0]!.id)))[0]!
        .status,
      "failed",
    );
    assert.deepEqual(
      await simulateTaskEvalJob(
        "33333333-3333-4333-8333-333333333333",
        { runId: queued.runs[1]!.id },
        deps,
      ),
      { simulated: false, reason: "run_not_found" },
    );
  } finally {
    await client.close();
  }
});

test("concurrent task rows reserve one shared organization budget and settle actual spend", {
  timeout: 20_000,
}, async () => {
  const { client, db, deps, fix } = await setup();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await seedCases(db, fix.id);
    await db.update(taskEvalCases).set({ criteria: "Find the order." });
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    let started!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const budgetDeps: TaskSimulationDeps = {
      ...deps,
      dailyBudgetUsd: 0.1,
      judgeBudgetUsd: 0.1,
      models: {
        agent: null,
        tool: null,
        standIn: false,
        judge: {
          model: "claude-sonnet-4-6",
          standIn: false,
          judge: async () => {
            calls++;
            started();
            await barrier;
            return { pass: true, usage: { inputTokens: 1000, outputTokens: 100 } };
          },
        },
      },
    };
    const first = simulateTaskEvalJob(PROJECT, { runId: queued.runs[0]!.id }, budgetDeps);
    await firstCall;
    assert.equal(
      await organizationModelSpendSince(PROJECT, new Date(Date.now() - 86_400_000), db),
      0.1,
      "the active row reserves the remaining budget",
    );
    const second = await simulateTaskEvalJob(PROJECT, { runId: queued.runs[1]!.id }, budgetDeps);
    assert.equal(second.simulated, true);
    const [blocked] = await db
      .select()
      .from(taskEvalRuns)
      .where(eq(taskEvalRuns.id, queued.runs[1]!.id));
    assert.equal(blocked!.judge?.status, "budget");
    release();
    await first;
    assert.equal(calls, 4, "only the first task calls the judge on its two cases");
    const spend = await organizationModelSpendSince(PROJECT, new Date(Date.now() - 86_400_000), db);
    assert.ok(Math.abs(spend - 0.018) < 1e-9, String(spend));
    assert.ok(spend <= 0.1);
  } finally {
    release();
    await client.close();
  }
});

test("queued task simulations keep the frozen judge criteria after an edit", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    await seedCases(db, fix.id);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Frozen task criteria." },
        updatedBy: "test",
      },
      db,
    );
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Edited task criteria." },
        updatedBy: "test",
      },
      db,
    );
    const run = queued.runs.find((row) => row.taskId === "task-a")!;
    let calls = 0;
    await simulateTaskEvalJob(
      PROJECT,
      { runId: run.id },
      {
        ...deps,
        models: {
          agent: null,
          tool: null,
          standIn: false,
          judge: {
            model: "claude-sonnet-4-6",
            standIn: false,
            judge: async ({ criteria, run }) => {
              assert.equal(criteria, "Frozen task criteria.");
              calls++;
              return {
                pass: run.includes("first search listed: notify, lookup_order"),
                usage: { inputTokens: 100, outputTokens: 10 },
              };
            },
          },
        },
      },
    );
    const [completed] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run.id));
    const task = completed!.breakdown!.task as Record<
      string,
      { before: { passed: number; total: number }; after: { passed: number; total: number } }
    >;
    assert.equal(task.judge_criteria.before.passed, 1);
    assert.equal(task.judge_criteria.after.passed, 0);
    assert.equal(task.judge_criteria.after.total, 1);
    assert.equal(calls, 4);
    assert.ok(Number(completed?.spend?.usd) > 0);
  } finally {
    await client.close();
  }
});

async function seedCases(db: ReturnType<typeof getDb>, fixId: string) {
  for (const taskId of ["task-a", "task-b"]) {
    await db.insert(taskEvalSets).values({ projectId: PROJECT, taskId, scorerVersion: 1 });
    const [turn] = await db
      .insert(traceTurns)
      .values({
        projectId: PROJECT,
        workflowId: taskId,
        sessionId: taskId,
        turnKey: taskId,
        turnSource: "declared",
        lane: "runtime",
        status: "closed",
        startedAt: new Date(),
        endedAt: new Date(),
        lastReceivedAt: new Date(),
      })
      .returning();
    await db.insert(traceTurnSteps).values([
      {
        projectId: PROJECT,
        turnId: turn!.id,
        traceEventId: randomUUID(),
        ordinal: 1,
        kind: "search",
        eventType: "search",
        occurredAt: new Date(),
        receivedAt: new Date(),
        hitIds: ["notify", "lookup_order"],
        hitCount: 2,
      },
      {
        projectId: PROJECT,
        turnId: turn!.id,
        traceEventId: randomUUID(),
        ordinal: 2,
        kind: "invoke",
        eventType: "invoke_end",
        occurredAt: new Date(),
        receivedAt: new Date(),
        targetType: "tool",
        targetId: "lookup_order",
        outcome: "ok",
      },
    ]);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId,
        scorer: { kind: "expected_tool", tool: "lookup_order" },
        updatedBy: "test",
      },
      db,
    );
    await upsertScorer(
      { projectId: PROJECT, taskId, scorer: { kind: "max_tool_calls", max: 2 }, updatedBy: "test" },
      db,
    );
    await db.insert(taskEvalCases).values([
      { projectId: PROJECT, taskId, turnId: turn!.id, origin: "auto" },
      {
        projectId: PROJECT,
        taskId,
        turnId: turn!.id,
        origin: "fix",
        fixId,
        expected: { tool: "notify" },
      },
      { projectId: PROJECT, taskId, turnId: turn!.id, origin: "fix", fixId: "another-fix" },
    ]);
  }
}

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const original = buildFixes(fixesInput()).open.find((fix) => fix.source === "rewrite")!;
  const fix: Fix = {
    ...original,
    kind: "fewer-results",
    subject: {
      ...original.subject,
      tasks: ["task-a", "task-b", "task-a"].map((id) => ({ id, label: id, href: "", color: null })),
    },
  };
  await db.insert(fixDrafts).values({
    projectId: PROJECT,
    fixId: fix.id,
    change: { ...emptyChange(), topK: 1 },
    status: "ready",
    origin: "user",
    createdBy: "test",
  });
  const deps: TaskSimulationDeps = {
    db,
    flagDeps: FLAGS_ON,
    loadFix: async () => ({ projectId: PROJECT, fix }),
    models: { agent: null, tool: null, judge: null, standIn: false },
    observability: { trackSystemEvent: async () => undefined },
  };
  return { client, db, deps, fix };
}

test("user test expectations enter the simulation alongside its criteria", async () => {
  const { client, db, deps, fix } = await setup();
  try {
    await seedCases(db, fix.id);
    await db
      .update(taskEvalCases)
      .set({
        origin: "user",
        expected: { tool: "notify", maxToolCalls: 0 },
        criteria: "Return the order status.",
      })
      .where(isNull(taskEvalCases.fixId));
    const queued = await runTaskSimulation(fix.id, { projectId: PROJECT, deps });
    const run = queued.runs.find((row) => row.taskId === "task-a")!;
    await simulateTaskEvalJob(PROJECT, { runId: run.id }, deps);
    const [completed] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run.id));
    const detail = await taskSimulationDetailFor(PROJECT, "task-a", fix, db);
    const userCase = detail.taskCases.find((row) => row.origin === "user")!;
    const shared = parseResults(completed!.results).find((row) => row.caseId === userCase.id)!;
    assert.equal(shared.after?.checks.find((check) => check.kind === "right_tool")?.pass, true);
  } finally {
    await client.close();
  }
});
