import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { resolveConfig } from "@/config";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { EnqueueScoreTasksDeps } from "@/lib/views/task-scorers/job";
import { enqueueTaskScores, taskScoresEnqueueStep } from "@/lib/views/task-scorers/register";

const ORG = "22222222-2222-4222-8222-222222222222";
const OFF = "11111111-1111-4111-8111-111111111111";
const ON = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-01T12:00:00Z");
const GATE_ON = resolveConfig({ override: { flags: { evalGate: true } } });
const scorersOn = async (projectId: string) => projectId === ON;

test("with customMonitoring on, neither trigger queues score_tasks, and eval sets still refresh", async () => {
  const { client, deps, jobs, events } = await setup();
  try {
    const step = taskScoresEnqueueStep(undefined, deps);
    assert.deepEqual(await step.run(), { taskScoresEnqueued: 1 });
    assert.deepEqual(await jobs("score_tasks"), [
      { project: OFF, status: "queued", reason: null },
      { project: ON, status: "done", reason: "trace_scorers" },
    ]);
    assert.deepEqual(
      (await jobs("refresh_task_eval_set")).map((job) => job.project),
      [ON],
      "the job that queued the eval sets does not run, so its trigger does",
    );
    assert.deepEqual(events, [["task_scores_skipped", "trace_scorers", "daily_sweep"]]);

    // The same UTC day: nothing more, as for any project.
    assert.deepEqual(await step.run(), { taskScoresEnqueued: 0 });
    assert.equal(events.length, 1);

    // The signal run's trigger.
    assert.equal(await enqueueTaskScores(ON, deps), null);
    assert.ok(await enqueueTaskScores(OFF, deps));
    const queued = (await jobs("score_tasks")).filter((job) => job.status === "queued");
    assert.deepEqual(
      queued.map((job) => job.project),
      [OFF, OFF],
    );
  } finally {
    await client.close();
  }
});

test("with customMonitoring off, both triggers queue score_tasks", async () => {
  const { client, deps, jobs } = await setup();
  try {
    const off = { ...deps, scorersOn: async () => false };
    assert.deepEqual(await taskScoresEnqueueStep(undefined, off).run(), { taskScoresEnqueued: 2 });
    assert.ok(await enqueueTaskScores(ON, off));
    assert.ok((await jobs("score_tasks")).every((job) => job.status === "queued"));
    assert.deepEqual(await jobs("refresh_task_eval_set"), []);
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${OFF}', '${ORG}', 'Off', 'off'), ('${ON}', '${ORG}', 'On', 'on');
    insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
    select id, 's', 's', 'declared', 'runtime', 'closed', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', '2026-11-01T10:00:01Z', 'task-a' from projects;
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const events: unknown[][] = [];
  const deps: EnqueueScoreTasksDeps & { scorersOn: typeof scorersOn } = {
    db,
    flagDeps: GATE_ON,
    now: () => NOW,
    scorersOn,
    logger: { info: () => undefined },
    observability: {
      trackSystemEvent: async (event: string, _actor: string, fields: Record<string, unknown>) => {
        events.push([event, fields.reason, fields.trigger]);
      },
    },
  };
  const jobs = async (kind: string) =>
    (
      await client.query<{ project: string; status: string; reason: string | null }>(
        `select project_id as project, status, result->>'reason' as reason from jobs where kind = $1 order by project_id, created_at`,
        [kind],
      )
    ).rows;
  return { client, deps, jobs, events };
}
