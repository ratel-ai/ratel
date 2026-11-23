import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { taskScoresDaily } from "@/lib/views/task-scorers/schema";
import { loadTaskScores } from "@/lib/views/tasks/live-scores";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-01T23:30:00Z");

test("live scores show today's overall rate and 14 UTC days with gaps, scoped to the project", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as BoundReadDb;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values
        ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent'),
        ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
    `);
    await db.insert(taskScoresDaily).values([
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-10-18",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 4,
        passed: 4,
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-10-19",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 4,
        passed: 1,
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-10-30",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 0,
        passed: 0,
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-11-01",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 20,
        passed: 15,
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-11-01",
        scorerKind: "ends_well",
        scorerVersion: 1,
        n: 20,
        passed: 20,
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        day: "2026-11-02",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 20,
        passed: 20,
      },
      {
        projectId: OTHER,
        taskId: "task-a",
        day: "2026-11-01",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 10,
        passed: 0,
      },
      {
        projectId: PROJECT,
        taskId: "task-b",
        day: "2026-10-31",
        scorerKind: "overall",
        scorerVersion: 1,
        n: 8,
        passed: 0,
      },
    ]);
    let reads = 0;
    const scores = await loadTaskScores(PROJECT, NOW, {
      read: async (_operation, read) => {
        reads++;
        return read(db);
      },
    });
    assert.equal(reads, 1, "one read serves every task");
    assert.deepEqual(scores?.get("task-a"), {
      rate: 0.75,
      runs: 20,
      history: [0.25, null, null, null, null, null, null, null, null, null, null, null, null, 0.75],
    });
    assert.deepEqual(
      scores?.get("task-b"),
      {
        rate: null,
        runs: 0,
        history: [null, null, null, null, null, null, null, null, null, null, null, null, 0, null],
      },
      "yesterday's score does not become today's score",
    );
  } finally {
    await client.close();
  }
});

test("a failed score read preserves the task list and marks scores unavailable", async () => {
  const scores = await loadTaskScores(PROJECT, NOW, {
    read: async () => {
      throw new Error("statement timeout");
    },
  });
  assert.equal(scores, null);
});
