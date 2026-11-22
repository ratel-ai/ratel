import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";
import { evalNightlySettings, evalSuiteSettings, evals } from "@/lib/views/evals/schema";
import {
  dailyRates,
  evalRunScores,
  saveRunScores,
  scoredTurns,
} from "@/lib/views/scorers/adapters/run-scores";
import type { ScoreResult } from "@/lib/views/scorers/domain/types";
import { runScores, scorers } from "@/lib/views/scorers/schema";

/**
 * RP-149: the Evals tables the upstream store tests leave out (eval_suite_settings,
 * eval_nightly_settings, run_scores), and core migration 0055 run on a database that already
 * has the tables, as production has them from ratel-cloud.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TURN_A = "44444444-4444-4444-8444-444444444444";
const TURN_B = "55555555-5555-4555-8555-555555555555";

test("suite run settings: empty without a row, set, replaced, and kept per project", async () => {
  const { client, store } = await setup();
  try {
    assert.deepEqual(await store.getSuiteRunSettings(PROJECT), {});

    await store.setSuiteRunSettings(PROJECT, { agentModel: "model-a", maxSteps: 8 }, "user_a");
    await store.setSuiteRunSettings(PROJECT, { agentModel: "model-b" }, "user_b");

    assert.deepEqual(await store.getSuiteRunSettings(PROJECT), { agentModel: "model-b" });
    assert.deepEqual(await store.getSuiteRunSettings(OTHER), {});
    const rows = await client.query<{ set_by: string }>(
      `select set_by from eval_suite_settings where project_id = '${PROJECT}'`,
    );
    assert.deepEqual(
      rows.rows.map((row) => row.set_by),
      ["user_b"],
    );
  } finally {
    await client.close();
  }
});

test("nightly settings: one row per project, off by default, removed with the project", async () => {
  const { client, db } = await setup();
  try {
    await db.insert(evalNightlySettings).values({ projectId: PROJECT, setBy: "user_a" });
    const [row] = await db
      .select()
      .from(evalNightlySettings)
      .where(eq(evalNightlySettings.projectId, PROJECT));
    assert.equal(row?.enabled, false);

    await db
      .insert(evalNightlySettings)
      .values({ projectId: PROJECT, enabled: true, setBy: "user_b" })
      .onConflictDoUpdate({
        target: evalNightlySettings.projectId,
        set: { enabled: true, setBy: "user_b" },
      });
    const after = await db.select().from(evalNightlySettings);
    assert.deepEqual(
      after.map((r) => [r.projectId, r.enabled, r.setBy]),
      [[PROJECT, true, "user_b"]],
    );

    await client.exec(`delete from projects where id = '${PROJECT}'`);
    assert.equal((await db.select().from(evalNightlySettings)).length, 0);
  } finally {
    await client.close();
  }
});

test("run scores: live and eval readings, a re-read replaces, daily rates skip skips", async () => {
  const { client, db, store } = await setup();
  try {
    const [scorer] = await db
      .insert(scorers)
      .values({
        projectId: PROJECT,
        taskId: "wf-a",
        scope: "task",
        name: "Ends well",
        kind: "check",
        createdBy: "user_a",
        updatedBy: "user_a",
      })
      .returning();
    const eval1 = await store.createEval({
      projectId: PROJECT,
      name: "Refund",
      message: "refund order 42",
      origin: "user",
      createdBy: "user_a",
    });
    const run = await store.createRun({ projectId: PROJECT, kind: "manual", createdBy: "user_a" });
    const at = { id: scorer!.id, version: 1 };

    await saveRunScores(
      PROJECT,
      [
        {
          scorer: at,
          day: "2026-11-20",
          turnId: TURN_A,
          result: reading(scorer!.id, "fail", 0, "no"),
        },
        {
          scorer: at,
          day: "2026-11-20",
          turnId: TURN_B,
          result: reading(scorer!.id, "skip", null, "n/a"),
        },
        {
          scorer: at,
          day: "2026-11-21",
          evalRunId: run.id,
          evalId: eval1.id,
          result: reading(scorer!.id, "pass", 1, "ok"),
        },
      ],
      db,
    );
    await saveRunScores(
      PROJECT,
      [
        {
          scorer: at,
          day: "2026-11-20",
          turnId: TURN_A,
          result: reading(scorer!.id, "pass", 1, "yes"),
        },
      ],
      db,
    );

    assert.deepEqual(await dailyRates(PROJECT, scorer!.id, db), [
      { day: "2026-11-20", n: 1, passed: 1 },
      { day: "2026-11-21", n: 1, passed: 1 },
    ]);
    assert.deepEqual(
      [...((await scoredTurns(PROJECT, [at], [TURN_A, TURN_B], db)).get(scorer!.id) ?? [])].sort(),
      [TURN_A, TURN_B],
    );
    const evalReadings = await evalRunScores(PROJECT, run.id, db);
    assert.deepEqual(
      evalReadings.map((r) => [r.evalId, r.status, r.passed]),
      [[eval1.id, "pass", true]],
    );
    assert.equal((await db.select().from(runScores)).length, 3);

    await assert.rejects(
      client.exec(
        `insert into run_scores (project_id, scorer_id, scorer_version, turn_id, eval_run_id, eval_id, day, status)
         values ('${PROJECT}', '${scorer!.id}', 1, '${TURN_A}', '${run.id}', '${eval1.id}', '2026-11-20', 'pass')`,
      ),
      /run_scores_subject_check/,
    );

    await db.delete(evals).where(eq(evals.id, eval1.id));
    assert.equal((await db.select().from(runScores)).length, 2);
  } finally {
    await client.close();
  }
});

test("migration 0055 is a no-op on a database that already has the Evals tables", async () => {
  const { client, db, store } = await setup();
  try {
    await store.createEval({
      projectId: PROJECT,
      name: "Kept",
      message: "hello",
      origin: "user",
      createdBy: "user_a",
    });
    await db
      .insert(evalSuiteSettings)
      .values({ projectId: PROJECT, runSettings: { maxSteps: 4 }, setBy: "user_a" });

    await client.exec(readFileSync(join(MIGRATIONS_DIR, "0055_evals.sql"), "utf8"));

    assert.deepEqual(
      (await store.listEvals(PROJECT)).map((e) => e.name),
      ["Kept"],
    );
    assert.deepEqual(await store.getSuiteRunSettings(PROJECT), { maxSteps: 4 });
  } finally {
    await client.close();
  }
});

function reading(
  scorerId: string,
  status: ScoreResult["status"],
  value: number | null,
  detail: string,
): ScoreResult {
  return { scorerId, kind: "check", status, value, detail };
}

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into projects (id, organization_id, name, slug) values ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  return { client, db, store: createDrizzleEvalStore(db) };
}
