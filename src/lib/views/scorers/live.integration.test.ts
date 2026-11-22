import assert from "node:assert/strict";
import { test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { runScores } from "@/lib/views/scorers/schema";
import { scoreTasksJob } from "@/lib/views/task-scorers/job";
import { dailyScoresFor } from "@/lib/views/task-scorers/store";
import { dailyRates } from "./adapters/run-scores";
import { drizzleScorerRepository } from "./adapters/store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-01T12:00:00Z");
// Owned: the task loop's gate is FF_EVAL_GATE, read from the flag deps as an environment.
const FLAGS_ON = { FF_EVAL_GATE: "true" };

test("the score job reads live runs with two user scorers of one kind and a judge, and keeps the daily counts", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, 1, 1000, "ok");
    await seedRun(client, 2, 4000, "error");
    const repo = drizzleScorerRepository(db);
    const fast = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Fast",
      kind: "check",
      config: { path: "latencyMs", op: "lte", value: 2000 },
      createdBy: "user_a",
    });
    const notify = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Calls notify",
      kind: "check",
      config: { path: "toolNames", op: "contains", value: "notify" },
      createdBy: "user_a",
    });
    const judged = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Ends well",
      kind: "judge",
      config: { criteria: "The call works." },
      createdBy: "user_a",
    });
    await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Off",
      kind: "check",
      config: { path: "latencyMs", op: "exists" },
      enabled: false,
      createdBy: "user_a",
    });

    let judgeCalls = 0;
    const judge = {
      model: "claude-sonnet-4-6",
      standIn: true,
      judge: async ({ run }: { run: string }) => {
        judgeCalls++;
        return { pass: !run.includes("[failed]"), usage: { inputTokens: 100, outputTokens: 5 } };
      },
    };
    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: { trackSystemEvent: async () => undefined },
      live: { judge, sample: 1 },
    };
    const result = await scoreTasksJob(PROJECT, deps);
    assert.equal(result.scored, true);
    assert.equal(
      (result as { userReadings?: number }).userReadings,
      5,
      "2 runs x 2 checks + 1 sampled judge reading",
    );

    const rows = await db
      .select()
      .from(runScores)
      .where(eq(runScores.projectId, PROJECT))
      .orderBy(asc(runScores.turnId), asc(runScores.scorerId));
    const byScorer = (id: string) =>
      rows.filter((row) => row.scorerId === id).map((row) => row.status);
    assert.deepEqual(byScorer(fast.id), ["pass", "fail"]);
    assert.deepEqual(byScorer(notify.id), ["pass", "pass"]);
    assert.deepEqual(byScorer(judged.id), ["pass"]);
    assert.equal(judgeCalls, 1);
    assert.ok(
      rows.every(
        (row) => row.day === "2026-11-01" && row.turnId !== null && row.evalRunId === null,
      ),
    );
    assert.deepEqual(await dailyRates(PROJECT, fast.id, db), [
      { day: "2026-11-01", n: 2, passed: 1 },
    ]);
    assert.ok(
      (await dailyScoresFor(PROJECT, "task-a", db)).some(
        (row) => row.scorerKind === "overall" && row.n === 2,
      ),
      "task_scores_daily stays filled",
    );

    // A rerun reads nothing again: every reading is current and the judge's sample is used.
    await scoreTasksJob(PROJECT, deps);
    assert.equal(judgeCalls, 1);
    assert.equal((await db.select().from(runScores)).length, 5);

    // A new version of a scorer reads the runs again.
    await repo.update(PROJECT, fast.id, {
      config: { path: "latencyMs", op: "lte", value: 5000 },
      updatedBy: "user_a",
    });
    await scoreTasksJob(PROJECT, deps);
    const again = await db
      .select()
      .from(runScores)
      .where(and(eq(runScores.scorerId, fast.id)));
    assert.deepEqual(
      again.map((row) => [row.status, row.scorerVersion]),
      [
        ["pass", 2],
        ["pass", 2],
      ],
    );
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

async function seedRun(
  client: Awaited<ReturnType<typeof setup>>["client"],
  n: number,
  durationMs: number,
  outcome: string,
) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  const start = new Date("2026-11-01T10:00:00Z");
  const end = new Date(start.getTime() + durationMs);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $6, $6, 'declared', 'runtime', 'closed', $3, $4, $4, $5)`,
    [id, PROJECT, start.toISOString(), end.toISOString(), "task-a", `run-${n}`],
  );
  await client.query(
    `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
     values ($1, $2, 1, 'invoke', 'invoke_end', gen_random_uuid(), $3, $3, 'tool', 'notify', $4)`,
    [id, PROJECT, start.toISOString(), outcome],
  );
}
