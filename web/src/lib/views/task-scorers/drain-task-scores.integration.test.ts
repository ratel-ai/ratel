import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type DrainCronDeps, runDrainTick } from "@/lib/jobs/drain";
import type { BackgroundObservabilityDeps } from "@/lib/jobs/observability";
import { claimNextQueuedJob, markJobDone, readJobQueueClock } from "@/lib/jobs/queries";
import { drainJobs, type JobStore } from "@/lib/jobs/runner";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { enqueueDueTaskScores, scoreTasksJob } from "@/lib/views/task-scorers/job";
import { taskScoresEnqueueStep } from "@/lib/views/task-scorers/register";
import { dailyScoresFor } from "@/lib/views/task-scorers/store";

/**
 * RC-622: one cron drain, with no signal run, fills `task_scores_daily` for each task with runs.
 *
 * Owned (ADR-0004): upstream turns the gate on for one organization and shows the other stays
 * unscored in the same drain. Here the gate is one switch for the deployment (`FF_EVAL_GATE`),
 * so the on and off cases are two drains, and the sweep is the registered drain step.
 */

type Db = ReturnType<typeof getDb>;

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-01T12:00:00Z");
const GATE_ON: OrganizationFlagDeps = { FF_EVAL_GATE: "1" };
const GATE_OFF: OrganizationFlagDeps = { FF_EVAL_GATE: "0" };
const SILENT = { trackSystemEvent: async () => undefined };

test("one cron drain writes task_scores_daily rows, overall included, for each task with runs", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, task: "task-a", day: "2026-10-30" });
    await seedRun(client, { n: 2, task: "task-a", day: "2026-11-01" });
    await seedRun(client, { n: 3, task: "task-b", day: "2026-11-01" });

    const body = await runDrainTick(drainDeps(db, GATE_ON));
    assert.deepEqual(body.steps.task_scores_enqueue, { taskScoresEnqueued: 1 });
    assert.equal(body.done, 1, "the same drain ran the score job it queued");
    assert.equal((await db.select().from(traceSignalRuns)).length, 0, "no signal run was involved");

    for (const taskId of ["task-a", "task-b"]) {
      const rows = await dailyScoresFor(PROJECT, taskId, db);
      assert.ok(rows.length > 0, `${taskId} has task_scores_daily rows`);
      assert.ok(
        rows.some((row) => row.scorerKind === "overall" && row.day === "2026-11-01" && row.n === 1),
        `${taskId} has today's overall row`,
      );
    }
    assert.deepEqual(
      (await dailyScoresFor(PROJECT, "task-a", db))
        .filter((row) => row.scorerKind === "overall")
        .map(({ day, n }) => ({ day, n })),
      [
        { day: "2026-10-30", n: 1 },
        { day: "2026-10-31", n: 0 },
        { day: "2026-11-01", n: 1 },
      ],
    );
  } finally {
    await client.close();
  }
});

test("with the gate off, the drain records the refusal and scores nothing", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, task: "task-a", day: "2026-11-01" });

    const body = await runDrainTick(drainDeps(db, GATE_OFF));
    assert.deepEqual(body.steps.task_scores_enqueue, { taskScoresEnqueued: 0 });
    assert.equal(body.done, 0, "a refusal is never queued");
    assert.deepEqual(
      await db
        .select({ status: schema.jobs.status, result: schema.jobs.result })
        .from(schema.jobs)
        .where(eq(schema.jobs.kind, "score_tasks")),
      [{ status: "done", result: { scored: false, reason: "gate_off", trigger: "daily_sweep" } }],
    );
    assert.deepEqual(
      await dailyScoresFor(PROJECT, "task-a", db),
      [],
      "the gate keeps the project unscored",
    );
  } finally {
    await client.close();
  }
});

/** The drain with the real sweep step, the real job runner and the real score handler, all on this database. */
function drainDeps(db: Db, flagDeps: OrganizationFlagDeps): DrainCronDeps {
  const observability: BackgroundObservabilityDeps = {
    trackServerEvent: async () => undefined,
    reportServerException: (error) => {
      throw new Error(`unexpected exception: ${String(error)}`);
    },
    now: () => 0,
    logError: (message, error) => {
      throw new Error(`${message}: ${String(error)}`);
    },
  };
  const jobStore: JobStore = {
    claimNextQueued: async (projectId, createdBefore, options) => {
      const row = await claimNextQueuedJob(projectId, createdBefore, db, options);
      return (
        row && {
          id: row.id,
          projectId: row.projectId,
          kind: row.kind,
          status: "running",
          payload: row.payload,
          createdAt: row.createdAt,
        }
      );
    },
    markDone: (id, result) => markJobDone(id, result, db),
    markError: async (id, error) => {
      await db
        .update(schema.jobs)
        .set({ status: "error", error, finishedAt: new Date() })
        .where(eq(schema.jobs.id, id));
    },
    queueClock: () => readJobQueueClock(db),
  };
  return {
    steps: [
      taskScoresEnqueueStep(() =>
        enqueueDueTaskScores({ db, flagDeps, now: () => NOW, observability: SILENT }),
      ),
    ],
    drainProjectJobs: (onJobFinished) =>
      drainJobs(
        jobStore,
        {
          score_tasks: (job) =>
            scoreTasksJob(job.projectId, { db, flagDeps, now: () => NOW, observability: SILENT }),
        },
        { ...(onJobFinished ? { onJobFinished } : {}) },
      ),
    observability,
  };
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'On', 'on');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

async function seedRun(
  client: Awaited<ReturnType<typeof createMigratedPGlite>>,
  input: { n: number; task: string; day: string },
) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(input.n).padStart(12, "0")}`;
  const start = new Date(`${input.day}T10:00:00Z`);
  const end = new Date(start.getTime() + 1000);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $6, $6, 'declared', 'runtime', 'closed', $3, $4, $4, $5)`,
    [id, PROJECT, start.toISOString(), end.toISOString(), input.task, `run-${input.n}`],
  );
  await client.query(
    `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
     values ($1, $2, 1, 'invoke', 'invoke_end', gen_random_uuid(), $3, $3, 'tool', 'notify', 'ok')`,
    [id, PROJECT, start.toISOString()],
  );
}
