import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { resolveConfig } from "@/config";
import type { DrainStep } from "@/lib/contracts/registry";
import { type DrainCronDeps, runDrainTick } from "@/lib/jobs/drain";
import type { BackgroundObservabilityDeps } from "@/lib/jobs/observability";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { enqueueDueTaskScores } from "@/lib/views/task-scorers/job";
import { taskScorersRegistration, taskScoresEnqueueStep } from "@/lib/views/task-scorers/register";

/**
 * RC-611: the drain's daily task scoring sweep, independent of the signal run.
 *
 * Owned (ADR-0030): upstream's drain took the sweep as a named dependency; here it is the task
 * scorers' registered `before` step, so the tick runs it through the drain-step registry. The
 * heartbeat keeps upstream's `taskScoresEnqueued`; a failure is reported under the step's name,
 * as for every registered step, where upstream kept a `taskScoreErrors` list.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
// The gate is the deployment's evalGate, not an organization flag.
const GATE_ON: OrganizationFlagDeps = resolveConfig({ override: { flags: { evalGate: true } } });

test("the task scorers register the sweep as a before-step of the drain", () => {
  assert.deepEqual(
    taskScorersRegistration.drainSteps?.map((s) => [s.name, s.phase, s.retentionOnly ?? false]),
    [["task_scores_enqueue", "before", false]],
  );
});

test("each drain tick queues one score_tasks job per project per UTC day, before it drains, with no signal run", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
        (gen_random_uuid(), '${PROJECT}', 's1', 's1', 'declared', 'runtime', 'closed', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', '2026-11-01T10:00:01Z', 'task-a'),
        (gen_random_uuid(), '${OTHER_PROJECT}', 's2', 's2', 'declared', 'runtime', 'closed', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', '2026-11-01T10:00:01Z', 'task-b');
    `);
    let now = new Date("2026-11-01T12:00:00Z");
    const order: string[] = [];
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    const deps = drainDeps(
      events,
      order,
      taskScoresEnqueueStep(async () => {
        order.push("score_sweep");
        return enqueueDueTaskScores({
          db,
          flagDeps: GATE_ON,
          now: () => now,
          observability: { trackSystemEvent: async () => undefined },
        });
      }),
    );

    const body = await runDrainTick(deps);
    assert.deepEqual(body.steps.task_scores_enqueue, { taskScoresEnqueued: 2 });
    assert.deepEqual(order, ["score_sweep", "drain"], "the same tick runs what it queued");
    assert.equal(
      events.find((e) => e.event === "cron_drain_completed")?.properties.taskScoresEnqueued,
      2,
    );

    const second = await runDrainTick(deps);
    assert.deepEqual(
      second.steps.task_scores_enqueue,
      { taskScoresEnqueued: 0 },
      "one job per project per day",
    );

    now = new Date("2026-11-02T00:01:00Z");
    const nextDay = await runDrainTick(deps);
    assert.deepEqual(nextDay.steps.task_scores_enqueue, { taskScoresEnqueued: 2 });
    const queued = await db
      .select({ projectId: schema.jobs.projectId })
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, "score_tasks"));
    assert.equal(queued.length, 4);
    assert.equal((await db.select().from(traceSignalRuns)).length, 0);
  } finally {
    await client.close();
  }
});

test("a failing task scoring sweep costs the drain nothing and is named", async () => {
  const order: string[] = [];
  const body = await runDrainTick(
    drainDeps(
      [],
      order,
      taskScoresEnqueueStep(async () => {
        throw new Error("db down");
      }),
    ),
  );
  assert.equal(body.ok, true);
  assert.equal(body.steps.task_scores_enqueue, null);
  assert.deepEqual(body.errors, { task_scores_enqueue: "db down" });
  assert.deepEqual(order, ["drain"]);
});

function drainDeps(
  events: { event: string; properties: Record<string, unknown> }[],
  order: string[],
  sweep: DrainStep,
): DrainCronDeps {
  const observability: BackgroundObservabilityDeps = {
    trackServerEvent: async (event, _context, properties) => {
      events.push({ event, properties: properties ?? {} });
    },
    reportServerException: () => undefined,
    now: () => 0,
    logError: () => undefined,
  };
  return {
    steps: [sweep],
    drainProjectJobs: async () => {
      order.push("drain");
      return { done: 0, failed: 0 };
    },
    observability,
  };
}
