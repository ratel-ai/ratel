import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { ScorerConfigError } from "../domain/config";
import { applicableScorers } from "../domain/engine";
import { drizzleScorerRepository } from "./store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const EVAL_A = "44444444-4444-4444-8444-444444444444";
const EVAL_B = "55555555-5555-4555-8555-555555555555";
const OTHER_EVAL = "66666666-6666-4666-8666-666666666666";

test("two scorers of one kind on a task, a suite scorer, and one eval's switch", async () => {
  const { client, repo } = await setup();
  try {
    const fast = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Fast",
      kind: "check",
      config: { path: "latencyMs", op: "lte", value: 3000 },
      createdBy: "user_a",
    });
    const cheap = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Cheap",
      kind: "check",
      config: { path: "costUsd", op: "lte", value: 0.01 },
      goodThreshold: 0.8,
      createdBy: "user_a",
    });
    const polite = await repo.create({
      projectId: PROJECT,
      scope: "suite",
      taskId: null,
      name: "Polite",
      kind: "judge",
      config: { criteria: "It is polite." },
      createdBy: "user_a",
    });
    await repo.create({
      projectId: OTHER_PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Elsewhere",
      kind: "check",
      config: { path: "latencyMs", op: "exists" },
      createdBy: "user_b",
    });

    assert.equal(cheap.goodThreshold, 0.8);
    assert.deepEqual(
      (await repo.list(PROJECT, { taskId: "task-a" })).map((s) => s.name),
      ["Fast", "Cheap"],
    );
    assert.deepEqual(
      (await repo.list(PROJECT, { scope: "suite" })).map((s) => s.name),
      ["Polite"],
    );
    assert.equal(
      await repo.get(OTHER_PROJECT, fast.id),
      null,
      "another project cannot read the scorer",
    );

    await repo.setOverride(PROJECT, EVAL_A, polite.id, false, "user_a");
    const overrides = await repo.overrides(PROJECT, [EVAL_A, EVAL_B]);
    const task = await repo.list(PROJECT, { taskId: "task-a" });
    const suite = await repo.list(PROJECT, { scope: "suite" });
    assert.deepEqual(
      applicableScorers(task, suite, overrides.get(EVAL_A)).map((s) => s.name),
      ["Fast", "Cheap"],
    );
    assert.deepEqual(
      applicableScorers(task, suite, overrides.get(EVAL_B)).map((s) => s.name),
      ["Fast", "Cheap", "Polite"],
    );

    await repo.setOverride(PROJECT, EVAL_A, polite.id, null, "user_a");
    assert.equal((await repo.overrides(PROJECT, [EVAL_A])).size, 0);
    await assert.rejects(
      repo.setOverride(PROJECT, OTHER_EVAL, polite.id, false, "user_a"),
      ScorerConfigError,
    );
  } finally {
    await client.close();
  }
});

test("updates validate and bump the version only when the reading changes", async () => {
  const { client, repo } = await setup();
  try {
    const rule = await repo.create({
      projectId: PROJECT,
      scope: "task",
      taskId: "task-a",
      name: "Rule",
      kind: "expression",
      config: { logic: { "<=": [{ var: "latencyMs" }, 3000] } },
      createdBy: "user_a",
    });
    assert.equal(rule.version, 1);
    assert.equal(
      (
        await repo.update(PROJECT, rule.id, {
          name: "Renamed",
          enabled: false,
          updatedBy: "user_a",
        })
      )?.version,
      1,
    );
    const changed = await repo.update(PROJECT, rule.id, {
      config: { logic: { "<=": [{ var: "latencyMs" }, 2000] } },
      updatedBy: "user_a",
    });
    assert.deepEqual([changed?.name, changed?.enabled, changed?.version], ["Renamed", false, 2]);
    await assert.rejects(
      repo.update(PROJECT, rule.id, { config: { logic: { regex: [1] } }, updatedBy: "user_a" }),
      /Unknown JSONLogic operator "regex"/,
    );
    await assert.rejects(
      repo.create({
        projectId: PROJECT,
        scope: "suite",
        taskId: "task-a",
        name: "X",
        kind: "judge",
        config: { criteria: "x" },
        createdBy: "user_a",
      }),
      /Leave the task out/,
    );
    await assert.rejects(
      repo.create({
        projectId: PROJECT,
        scope: "task",
        taskId: null,
        name: "X",
        kind: "judge",
        config: { criteria: "x" },
        createdBy: "user_a",
      }),
      /needs its task id/,
    );
    assert.equal(await repo.remove(OTHER_PROJECT, rule.id), false);
    assert.equal(await repo.remove(PROJECT, rule.id), true);
    assert.equal(await repo.get(PROJECT, rule.id), null);
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');
    insert into evals (id, project_id, name, message, origin, created_by) values
      ('${EVAL_A}', '${PROJECT}', 'A', 'hi', 'user', 'user_a'),
      ('${EVAL_B}', '${PROJECT}', 'B', 'hi', 'user', 'user_a'),
      ('${OTHER_EVAL}', '${OTHER_PROJECT}', 'C', 'hi', 'user', 'user_b');
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  return { client, repo: drizzleScorerRepository(db) };
}
