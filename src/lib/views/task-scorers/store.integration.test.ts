import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  dailyScoresFor,
  resetScorer,
  scorersFor,
  upsertDailyScores,
  upsertScorer,
} from "@/lib/views/task-scorers/store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

test("user scorers override task defaults until reset and remain scoped to the task", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, PROJECT, "task-a", 1, 1000);
    await seedRun(client, PROJECT, "task-a", 2, 1002);
    await seedRun(client, PROJECT, "task-b", 3, 90000);
    await seedRun(client, OTHER_PROJECT, "task-a", 4, 80000);
    await seedRun(client, PROJECT, "task-a", 5, 70000, "open");
    assert.deepEqual(await scorersFor(PROJECT, "task-a", db), [
      { kind: "ends_well", enabled: true, source: "default", version: 1 },
      { kind: "max_self_corrections", max: 0, enabled: true, source: "default", version: 1 },
      { kind: "max_latency_ms", max: 1252, enabled: true, source: "default", version: 1 },
    ]);
    const first = await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 3000 },
        enabled: false,
        updatedBy: "user_test",
      },
      db,
    );
    assert.equal(first.source, "user");
    assert.equal(first.updatedBy, "user_test");
    assert.ok(first.updatedAt instanceof Date);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 9000 },
        source: "default",
        updatedBy: "system:task-scorers",
      },
      db,
    );
    assert.deepEqual(
      (await scorersFor(PROJECT, "task-a", db)).find((row) => row.kind === "max_latency_ms"),
      {
        kind: "max_latency_ms",
        max: 3000,
        enabled: false,
        source: "user",
        version: 1,
      },
      "a refreshed default cannot replace a disabled user scorer",
    );
    const second = await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 4000 },
        updatedBy: "user_other",
      },
      db,
    );
    assert.equal(second.version, 2);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "expected_tool", tool: "notify" },
        updatedBy: "user_test",
      },
      db,
    );
    assert.deepEqual(
      (await scorersFor(PROJECT, "task-a", db)).find((row) => row.kind === "expected_tool"),
      {
        kind: "expected_tool",
        tool: "notify",
        enabled: true,
        source: "user",
        version: 1,
      },
    );
    assert.deepEqual(
      (await scorersFor(PROJECT, "task-b", db)).find((row) => row.kind === "max_latency_ms"),
      {
        kind: "max_latency_ms",
        max: 112500,
        enabled: true,
        source: "default",
        version: 1,
      },
    );
    assert.deepEqual(
      (await scorersFor(OTHER_PROJECT, "task-a", db)).find((row) => row.kind === "max_latency_ms"),
      {
        kind: "max_latency_ms",
        max: 100000,
        enabled: true,
        source: "default",
        version: 1,
      },
    );
    assert.equal(await resetScorer(OTHER_PROJECT, "task-a", "max_latency_ms", db), false);
    assert.equal(await resetScorer(PROJECT, "task-a", "max_latency_ms", db), true);
    assert.deepEqual(
      (await scorersFor(PROJECT, "task-a", db)).find((row) => row.kind === "max_latency_ms"),
      {
        kind: "max_latency_ms",
        max: 1252,
        enabled: true,
        source: "default",
        version: 1,
      },
    );
    assert.deepEqual(await scorersFor(PROJECT, "missing-task", db), [
      { kind: "ends_well", enabled: true, source: "default", version: 1 },
    ]);
  } finally {
    await client.close();
  }
});

test("same-day scores replace the overall row and preserve other tasks and projects", async () => {
  const { client, db } = await setup();
  try {
    await upsertDailyScores(
      PROJECT,
      "task-a",
      "2026-11-01",
      [
        { scorerKind: "overall", scorerVersion: 1, n: 10, passed: 6 },
        { scorerKind: "ends_well", scorerVersion: 1, n: 10, passed: 8 },
      ],
      db,
    );
    await upsertDailyScores(
      PROJECT,
      "task-b",
      "2026-11-01",
      [{ scorerKind: "overall", scorerVersion: 1, n: 3, passed: 3 }],
      db,
    );
    await upsertDailyScores(
      OTHER_PROJECT,
      "task-a",
      "2026-11-01",
      [{ scorerKind: "overall", scorerVersion: 1, n: 5, passed: 4 }],
      db,
    );
    await upsertDailyScores(
      PROJECT,
      "task-a",
      "2026-11-01",
      [
        { scorerKind: "overall", scorerVersion: 2, n: 12, passed: 9 },
        { scorerKind: "ends_well", scorerVersion: 2, n: 12, passed: 11 },
      ],
      db,
    );
    await upsertDailyScores(
      PROJECT,
      "task-a",
      "2026-11-02",
      [{ scorerKind: "overall", scorerVersion: 2, n: 0, passed: 0 }],
      db,
    );
    await upsertDailyScores(PROJECT, "task-a", "2026-11-02", [], db);

    const rows = await dailyScoresFor(PROJECT, "task-a", db);
    assert.deepEqual(
      rows.map(({ day, scorerKind, scorerVersion, n, passed }) => ({
        day,
        scorerKind,
        scorerVersion,
        n,
        passed,
      })),
      [
        { day: "2026-11-01", scorerKind: "ends_well", scorerVersion: 2, n: 12, passed: 11 },
        { day: "2026-11-01", scorerKind: "overall", scorerVersion: 2, n: 12, passed: 9 },
        { day: "2026-11-02", scorerKind: "overall", scorerVersion: 2, n: 0, passed: 0 },
      ],
    );
    assert.equal((await dailyScoresFor(PROJECT, "task-b", db))[0]!.n, 3);
    assert.equal((await dailyScoresFor(OTHER_PROJECT, "task-a", db))[0]!.n, 5);
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
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

async function seedRun(
  client: Awaited<ReturnType<typeof setup>>["client"],
  project: string,
  task: string,
  n: number,
  durationMs: number,
  status = "closed",
) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  const start = new Date("2026-11-01T10:00:00Z");
  const end = new Date(start.getTime() + durationMs);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $7, $7, 'declared', 'runtime', $3, $4, $5, $5, $6)`,
    [id, project, status, start.toISOString(), end.toISOString(), task, `run-${n}`],
  );
  await client.query(
    `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
     values ($1, $2, 1, 'invoke', 'invoke_end', gen_random_uuid(), $3, $3, 'tool', 'notify', 'ok')`,
    [id, project, start.toISOString()],
  );
}
