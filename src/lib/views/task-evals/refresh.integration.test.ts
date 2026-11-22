import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import {
  type RefreshTaskEvalSetDeps,
  refreshTaskEvalSet,
  taskEvalSetFor,
} from "@/lib/views/task-evals/store";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-01T12:00:00Z");
// Owned (ADR-0030): the gate is FF_EVAL_GATE from the environment, not an organization flag.
const FLAGS_ON: OrganizationFlagDeps = { FF_EVAL_GATE: "1" };
const observability = { trackSystemEvent: async () => undefined };

test("refresh preserves pins, user edits and fix cases while removing stale cases and respecting exclusions", async () => {
  const { client, db } = await setup();
  try {
    const deps = { db, flagDeps: FLAGS_ON, now: () => NOW, observability };
    await refreshTaskEvalSet(PROJECT, "task-a", deps);
    const first = await taskEvalSetFor(PROJECT, "task-a", db);
    assert.equal(first.set?.targetRuns, 20);
    assert.equal(first.set?.scorerVersion, SCORER_VERSION);
    assert.equal(first.set?.refreshedAt?.toISOString(), NOW.toISOString());
    assert.equal(first.cases.length, 20);
    // These old runs are outside the next 200-run pool.
    await db.insert(taskEvalCases).values([
      {
        projectId: PROJECT,
        taskId: "task-a",
        turnId: id(1),
        origin: "auto",
        pinned: true,
        criteria: "Keep the pin.",
        expected: { tool: "notify" },
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        turnId: id(2),
        origin: "user",
        criteria: "Keep the user case.",
      },
      {
        projectId: PROJECT,
        taskId: "task-a",
        turnId: id(3),
        origin: "fix",
        fixId: "rewrite:test",
        criteria: "Keep the fix case.",
      },
      { projectId: PROJECT, taskId: "task-a", turnId: id(4), origin: "auto" },
      { projectId: PROJECT, taskId: "task-a", turnId: id(5), origin: "user", pinned: true },
    ]);
    const excluded = first.cases[0]!.turnId;
    await db
      .update(taskEvalCases)
      .set({ excludedAt: NOW })
      .where(and(eq(taskEvalCases.projectId, PROJECT), eq(taskEvalCases.turnId, excluded)));
    await client.exec(`delete from trace_turns where id = '${id(5)}'`);
    const result = await refreshTaskEvalSet(PROJECT, "task-a", deps);
    assert.equal(result.refreshed, true);
    const after = await taskEvalSetFor(PROJECT, "task-a", db);
    const active = after.cases.filter((row) => row.excludedAt === null);
    assert.ok(active.filter((row) => row.fixId === null).length >= 20);
    assert.equal(active.find((row) => row.turnId === id(1))?.criteria, "Keep the pin.");
    assert.deepEqual(active.find((row) => row.turnId === id(1))?.expected, { tool: "notify" });
    assert.equal(active.find((row) => row.turnId === id(2))?.origin, "user");
    assert.equal(active.find((row) => row.turnId === id(3))?.fixId, "rewrite:test");
    for (const turnId of [id(4), id(5), excluded])
      assert.ok(!active.some((row) => row.turnId === turnId));
    assert.ok(
      after.cases.find((row) => row.turnId === excluded)?.excludedAt,
      "an exclusion remains recorded",
    );
    await refreshTaskEvalSet(PROJECT, "task-a", deps);
    assert.deepEqual((await taskEvalSetFor(PROJECT, "task-a", db)).cases, after.cases);
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, '${PROJECT}', 'run-' || g, 'run-' || g,
        'declared', 'runtime', 'closed', '2026-11-01T00:00:00Z'::timestamptz + g * interval '1 minute',
        '2026-11-01T00:00:01Z'::timestamptz + g * interval '1 minute', now(), 'task-a' from generate_series(1, 240) g;
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

function id(n: number) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

test("refresh updates automatic selection reasons when an issue resolves", async () => {
  const { client, db } = await setup();
  try {
    const deps = { db, flagDeps: FLAGS_ON, now: () => NOW, observability };
    await client.exec(`
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        values ('${PROJECT}', 'error_loop', 'workflow', 'task-a', 1, 1, 1, '{"turnIds":["${id(240)}"]}', now(), now());
    `);
    await refreshTaskEvalSet(PROJECT, "task-a", deps);
    const first = (await taskEvalSetFor(PROJECT, "task-a", db)).cases.find(
      (row) => row.turnId === id(240),
    )!;
    assert.equal(first.origin, "issue");
    await client.exec(
      `update trace_signals set status = 'resolved' where project_id = '${PROJECT}'`,
    );
    await refreshTaskEvalSet(PROJECT, "task-a", deps);
    const second = (await taskEvalSetFor(PROJECT, "task-a", db)).cases.find(
      (row) => row.turnId === id(240),
    )!;
    assert.equal(second.id, first.id);
    assert.equal(second.origin, "auto");
    assert.notEqual(second.selectionReason, first.selectionReason);
  } finally {
    await client.close();
  }
});

test("the case key treats null fix ids as equal and keeps fix-specific cases separate", async () => {
  const { client, db } = await setup();
  try {
    await refreshTaskEvalSet(PROJECT, "task-a", {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability,
    });
    const before = await taskEvalSetFor(PROJECT, "task-a", db);
    const turnId = before.cases[0]!.turnId;
    await db
      .insert(taskEvalCases)
      .values({ projectId: PROJECT, taskId: "task-a", turnId, origin: "auto" })
      .onConflictDoNothing();
    await db
      .insert(taskEvalCases)
      .values([
        { projectId: PROJECT, taskId: "task-a", turnId, origin: "fix", fixId: "rewrite:a" },
        { projectId: PROJECT, taskId: "task-a", turnId, origin: "fix", fixId: "rewrite:b" },
      ])
      .onConflictDoNothing();
    const after = await taskEvalSetFor(PROJECT, "task-a", db);
    assert.equal(after.cases.length, 22);
    assert.deepEqual(
      after.cases.filter((row) => row.turnId === turnId).map((row) => row.fixId),
      ["rewrite:a", "rewrite:b", null],
    );
  } finally {
    await client.close();
  }
});

test("refresh shrinks an over-target set while pins, user and fix cases stay outside the budget", async () => {
  const { client, db } = await setup();
  try {
    await db.insert(taskEvalSets).values({
      projectId: PROJECT,
      taskId: "task-a",
      targetRuns: 20,
      scorerVersion: SCORER_VERSION,
    });
    await db.insert(taskEvalCases).values(
      Array.from({ length: 80 }, (_, i) => ({
        projectId: PROJECT,
        taskId: "task-a",
        turnId: id(161 + i),
        origin: i === 78 ? ("user" as const) : ("auto" as const),
        pinned: i === 79,
        criteria: i === 79 ? "Preserve the pin." : "",
      })),
    );
    await db.insert(taskEvalCases).values({
      projectId: PROJECT,
      taskId: "task-a",
      turnId: id(238),
      origin: "fix",
      fixId: "rewrite:test",
    });
    await client.exec(`
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        select '${PROJECT}', 'error_loop', 'workflow', 'task-a', 1, 1, 80,
          jsonb_build_object('turnIds', jsonb_agg(id)), now(), now() from trace_turns where id >= '${id(161)}';
    `);
    const events: Record<string, unknown>[] = [];
    const deps: RefreshTaskEvalSetDeps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: {
        trackSystemEvent: async (_event, _actor, properties) => {
          events.push(properties);
        },
      },
    };
    const result = await refreshTaskEvalSet(PROJECT, "task-a", deps);
    const active = (await taskEvalSetFor(PROJECT, "task-a", db)).cases.filter(
      (row) => row.excludedAt === null,
    );
    const automatic = active.filter(
      (row) => !row.pinned && row.fixId === null && row.origin !== "user",
    );
    assert.equal(automatic.length, 20);
    assert.equal(active.length, 23);
    assert.equal(active.find((row) => row.turnId === id(240))?.criteria, "Preserve the pin.");
    assert.equal(active.find((row) => row.turnId === id(239))?.origin, "user");
    assert.equal(active.find((row) => row.fixId === "rewrite:test")?.turnId, id(238));
    // The fix trace remains eligible for the shared sample.
    assert.equal(result.refreshed && result.issue_capped, 76);
    assert.equal(events[0]?.issue_capped, 76);
  } finally {
    await client.close();
  }
});
