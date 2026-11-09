import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { enqueueTaskEvalRefreshJob, refreshTaskEvalSetJob } from "@/lib/views/task-evals/job";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { taskEvalSetFor } from "@/lib/views/task-evals/store";
import { scoreTasksJob } from "@/lib/views/task-scorers/job";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-01T12:00:00Z");
// Owned (ADR-0030): the gate is FF_EVAL_GATE from the environment, not an organization flag.
const FLAGS_ON: OrganizationFlagDeps = { FF_EVAL_GATE: "1" };
const observability = { trackSystemEvent: async () => undefined };

test("refresh jobs and enqueue requests write nothing when the eval gate is off", async () => {
  const { client, db } = await setup();
  try {
    const flagDeps: OrganizationFlagDeps = { FF_EVAL_GATE: "0" };
    assert.deepEqual(await refreshTaskEvalSetJob(PROJECT, { taskId: "task-a" }, { db, flagDeps }), {
      refreshed: false,
      reason: "gate_off",
    });
    assert.equal(await enqueueTaskEvalRefreshJob(PROJECT, "task-a", { db, flagDeps }), null);
    assert.deepEqual(await taskEvalSetFor(PROJECT, "task-a", db), { set: null, cases: [] });
    assert.deepEqual(await db.select().from(jobs), []);
  } finally {
    await client.close();
  }
});

test("scoring queues a weekly refresh and explicit requests bypass the weekly limit", async () => {
  const { client, db } = await setup();
  try {
    const events: Record<string, unknown>[] = [];
    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: {
        trackSystemEvent: async (
          _event: unknown,
          _actor: unknown,
          fields: Record<string, unknown>,
        ) => {
          events.push(fields);
        },
      },
    };
    await scoreTasksJob(PROJECT, { ...deps, observability });
    const [queued] = await db.select().from(jobs).where(eq(jobs.kind, "refresh_task_eval_set"));
    assert.ok(queued);
    assert.deepEqual(queued.payload, { taskId: "task-a", scheduled: true });
    await scoreTasksJob(PROJECT, { ...deps, observability });
    assert.equal((await db.select().from(jobs)).length, 1, "pending refreshes coalesce");
    const first = await refreshTaskEvalSetJob(PROJECT, queued.payload, deps);
    assert.equal(first.refreshed, true);
    assert.equal("short_of_target" in first && first.short_of_target, 19);
    assert.deepEqual(await refreshTaskEvalSetJob(PROJECT, queued.payload, deps), {
      refreshed: false,
      reason: "recent",
    });
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, queued.id));
    await scoreTasksJob(PROJECT, { ...deps, observability });
    assert.equal((await db.select().from(jobs)).length, 1, "weekly refresh is not due");
    const manual = await enqueueTaskEvalRefreshJob(PROJECT, "task-a", deps);
    assert.ok(manual);
    const [manualJob] = await db.select().from(jobs).where(eq(jobs.id, manual.id));
    assert.deepEqual(manualJob?.payload, { taskId: "task-a", scheduled: false });
    assert.equal((await refreshTaskEvalSetJob(PROJECT, manualJob!.payload, deps)).refreshed, true);
    assert.equal(events[0]?.object_action, "task_eval_set_refreshed");
    assert.equal(events[0]?.project_id, PROJECT);
    assert.equal(events[0]?.task_id, "task-a");
    assert.equal(events[0]?.added, 1);
    assert.equal(events[0]?.short_of_target, 19);
    assert.equal(typeof events[0]?.duration_ms, "number");
    const later = { ...deps, now: () => new Date("2026-11-08T12:00:00Z") };
    assert.equal((await refreshTaskEvalSetJob(PROJECT, queued.payload, later)).refreshed, true);
    assert.deepEqual(await refreshTaskEvalSetJob(PROJECT, {}, deps), {
      refreshed: false,
      reason: "invalid_payload",
    });
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      values ('${PROJECT}', 'one', 'one', 'declared', 'runtime', 'closed', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', now(), 'task-a');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}
