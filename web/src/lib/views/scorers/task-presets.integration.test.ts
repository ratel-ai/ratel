import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { resolveConfig } from "@/config";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, MIGRATIONS_DIR } from "@/lib/platform/db/test-support";
import { scoreTasksJob } from "@/lib/views/task-scorers/job";
import { dailyScoresFor, scorersFor, upsertScorer } from "@/lib/views/task-scorers/store";
import { MAX_SCORERS } from "./config";
import { countScorers, deleteScorer, listTaskScorers } from "./store";
import { sweepScorers } from "./sweep";
import {
  resetTaskScorer,
  ScorerLimitError,
  saveTaskScorer,
  seedTaskPresets,
  syncTaskPreset,
} from "./task-presets";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const MIGRATION = "0055_task_scorers_to_presets.sql";

test("the migration turns each task scorer into a scorer attached to its task; a second run adds nothing", async () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const client = new PGlite();
  try {
    for (const file of files.slice(0, files.indexOf(MIGRATION))) await client.exec(read(file));
    // `organizations` is the edition's table: the projects here need none.
    await client.exec(`
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
      insert into task_scorers (project_id, task_id, kind, config, enabled, source, updated_by) values
        ('${PROJECT}', 'task-a', 'ends_well', '{}', true, 'default', 'system'),
        ('${PROJECT}', 'task-a', 'max_self_corrections', '{"max": 1}', true, 'user', 'u1'),
        ('${PROJECT}', 'task-a', 'max_latency_ms', '{"max": 2000}', false, 'user', 'u1'),
        ('${PROJECT}', 'task-a', 'max_cost_usd', '{"max": 0.1}', true, 'user', 'u1'),
        ('${PROJECT}', 'task-a', 'expected_tool', '{"tool": " book "}', true, 'user', 'u1'),
        ('${PROJECT}', 'task-a', 'max_tool_calls', '{"max": 4}', true, 'user', 'u1'),
        ('${PROJECT}', 'task-a', 'judge_criteria', '{"criteria": "Did it book?"}', true, 'user', 'u1'),
        ('${PROJECT}', 'task-b', 'max_cost_usd', '{}', true, 'user', 'u1');
    `);
    const migration = read(MIGRATION);
    await client.exec(migration);
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    const attached = await listTaskScorers(PROJECT, "task-a", db);
    assert.deepEqual(
      attached
        .map((scorer) => [scorer.kind, scorer.config, scorer.enabled, scorer.tasks])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        // A judge starts disabled: nothing starts to spend.
        ["judge", { prompt: "Did it book?", output: "boolean" }, false, ["task-a"]],
        ["preset", { preset: "ends_well" }, true, ["task-a"]],
        ["preset", { preset: "expected_tool", tool: "book" }, true, ["task-a"]],
        ["preset", { preset: "max_cost_usd", max: 0.1 }, true, ["task-a"]],
        ["preset", { preset: "max_latency_ms", max: 2000 }, false, ["task-a"]],
        ["preset", { preset: "max_self_corrections", max: 1 }, true, ["task-a"]],
        ["preset", { preset: "max_tool_calls", max: 4 }, true, ["task-a"]],
      ],
    );
    assert.ok(attached.some((scorer) => scorer.name === "Run time · task-a"));
    // A row whose settings do not parse is left out.
    assert.deepEqual(await listTaskScorers(PROJECT, "task-b", db), []);

    const count = async () =>
      (await client.query<{ n: number }>("select count(*)::int as n from trace_scorers")).rows[0]
        ?.n;
    const conversion = migration.split("--> statement-breakpoint").at(-1)!;
    await client.exec(conversion);
    assert.equal(await count(), 7);
  } finally {
    await client.close();
  }
});

test("near the limit, the migration converts every definition, once, out of the limit, and the sweep runs them all", async () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const client = new PGlite();
  try {
    for (const file of files.slice(0, files.indexOf(MIGRATION))) await client.exec(read(file));
    const existing = MAX_SCORERS - 5;
    await client.exec(`
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
      insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
        select '${PROJECT}', 'Fast ' || n, 'check', '{"path":"duration_ms","op":"lte","value":1000}', 'u1', 'u1'
        from generate_series(1, ${existing}) n;
      insert into task_scorers (project_id, task_id, kind, config, enabled, source, updated_by)
        select '${PROJECT}', t, k, c::jsonb, k <> 'max_cost_usd', 'user', 'u1'
        from (values ('task-a'), ('task-b')) tasks(t),
          (values ('ends_well', '{}'), ('max_self_corrections', '{"max": 1}'),
            ('max_latency_ms', '{"max": 2000}'), ('max_cost_usd', '{"max": 0.1}'),
            ('expected_tool', '{"tool": "book"}'), ('max_tool_calls', '{"max": 4}'),
            ('judge_criteria', '{"criteria": "Did it book?"}')) kinds(k, c);
    `);
    const migration = read(MIGRATION);
    await client.exec(migration);
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    // The converted scorers are the system's: a person's room under the limit stays.
    assert.equal(await countScorers(PROJECT, db), existing);
    for (const task of ["task-a", "task-b"]) {
      const attached = await listTaskScorers(PROJECT, task, db);
      assert.equal(attached.length, 7, task);
      // A judge starts disabled: nothing starts to spend.
      assert.deepEqual(
        attached
          .filter((scorer) => !scorer.enabled)
          .map((scorer) => scorer.config)
          .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
        [
          { preset: "max_cost_usd", max: 0.1 },
          { output: "boolean", prompt: "Did it book?" },
        ],
        task,
      );
    }
    await client.exec(migration.split("--> statement-breakpoint").at(-1)!);
    assert.equal((await listTaskScorers(PROJECT, "task-a", db)).length, 7);

    // The sweep reads tables of later migrations (org_holds): the schema as a deploy leaves it.
    for (const file of files.slice(files.indexOf(MIGRATION) + 1)) await client.exec(read(file));
    // The sweep takes every enabled scorer, past the limit: 95 checks and 10 presets (no judge engine).
    const sweep = await sweepScorers({ judge: { engine: null } }, db);
    assert.equal(sweep.scorers, existing + 10);
  } finally {
    await client.close();
  }
});

test("a new task gets its task scorers once: the defaults from its runs, with what a person set", async () => {
  const { client, db } = await setup();
  try {
    for (const [n, durationMs] of [
      [1, 1000],
      [2, 3000],
    ] as const)
      await addRun(client, n, durationMs);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 2 },
        enabled: false,
        updatedBy: "u1",
      },
      db,
    );
    const expected = await scorersFor(PROJECT, "task-a", db);
    assert.equal(await seedTaskPresets(PROJECT, new Date(), db), expected.length);
    const attached = await listTaskScorers(PROJECT, "task-a", db);
    assert.deepEqual(
      attached
        .map((scorer) => (scorer.kind === "preset" ? scorer.config.preset : scorer.kind))
        .sort(),
      expected.map((scorer) => scorer.kind).sort(),
    );
    assert.equal(
      attached.find(
        (scorer) => scorer.kind === "preset" && scorer.config.preset === "max_tool_calls",
      )?.enabled,
      false,
    );

    // Once: a preset a person deletes does not come back.
    await deleteScorer(PROJECT, attached[0]!.id, db);
    assert.equal(await seedTaskPresets(PROJECT, new Date(), db), 0);
    assert.equal((await listTaskScorers(PROJECT, "task-a", db)).length, expected.length - 1);
  } finally {
    await client.close();
  }
});

test("the seed does not count against the limit: at the limit a task still gets its defaults, and people keep their room", async () => {
  const { client, db } = await setup();
  try {
    await fill(client, MAX_SCORERS - 1);
    for (const [n, durationMs] of [
      [1, 1000],
      [2, 3000],
    ] as const)
      await addRun(client, n, durationMs);
    const expected = await scorersFor(PROJECT, "task-a", db);
    assert.ok(expected.length > 1);
    assert.equal(await seedTaskPresets(PROJECT, new Date(), db), expected.length);
    assert.equal((await listTaskScorers(PROJECT, "task-a", db)).length, expected.length);
    assert.equal(await countScorers(PROJECT, db), MAX_SCORERS - 1, "one slot is still a person's");
  } finally {
    await client.close();
  }
});

test("a change of a task scorer moves its scorer of the one model: updated, created, or detached", async () => {
  const { client, db } = await setup();
  try {
    const presetOf = async (kind: string) =>
      (await listTaskScorers(PROJECT, "task-a", db)).find(
        (scorer) => scorer.kind === "preset" && scorer.config.preset === kind,
      );
    const latency = { kind: "max_latency_ms" as const, max: 1000 };
    assert.ok(
      await syncTaskPreset(PROJECT, "task-a", undefined, { ...latency, enabled: true }, "u1", db),
    );
    const created = await presetOf("max_latency_ms");
    assert.deepEqual(
      [created?.config, created?.enabled],
      [{ preset: "max_latency_ms", max: 1000 }, true],
    );

    assert.ok(
      await syncTaskPreset(
        PROJECT,
        "task-a",
        latency,
        { kind: "max_latency_ms", max: 500, enabled: false },
        "u1",
        db,
      ),
    );
    const updated = await presetOf("max_latency_ms");
    assert.deepEqual(
      [updated?.id, updated?.config, updated?.enabled],
      [created?.id, { preset: "max_latency_ms", max: 500 }, false],
    );

    assert.ok(await syncTaskPreset(PROJECT, "task-a", latency, undefined, "u1", db));
    assert.equal(await presetOf("max_latency_ms"), undefined);
  } finally {
    await client.close();
  }
});

test("after 0055, every task scorer write moves its converted scorer: no stale limit, no second judge", async () => {
  const { client, db } = await migratedWith(`
    ('${PROJECT}', 'task-a', 'max_latency_ms', '{"max": 2000}', true, 'user', 'u1'),
    ('${PROJECT}', 'task-a', 'judge_criteria', '{"criteria": "Did it book?"}', true, 'user', 'u1')`);
  try {
    // The task page and MCP save through these; under the limit the sync runs.
    const save = (scorer: Parameters<typeof saveTaskScorer>[0]["scorer"], enabled = true) =>
      saveTaskScorer(
        { projectId: PROJECT, taskId: "task-a", scorer, enabled, updatedBy: "u1" },
        db,
      );
    await save({ kind: "max_latency_ms", max: 9000 });
    await save({ kind: "judge_criteria", criteria: "Did it book a room?" }, false);
    await addRun(client, 1, 1000);
    await seedTaskPresets(PROJECT, new Date(), db);
    const attached = await listTaskScorers(PROJECT, "task-a", db);
    assert.deepEqual(
      attached
        .filter((scorer) => scorer.kind !== "preset" || scorer.config.preset === "max_latency_ms")
        .map((scorer) => [scorer.kind, scorer.config, scorer.enabled])
        // Both come from one migration statement: the same creation time, so no stable order.
        .sort(([a], [b]) => String(b).localeCompare(String(a))),
      [
        ["preset", { preset: "max_latency_ms", max: 9000 }, true],
        ["judge", { prompt: "Did it book a room?", output: "boolean" }, false],
      ],
    );
    // A reset to no default detaches it from the task.
    await resetTaskScorer(PROJECT, "task-a", "judge_criteria", "u1", db);
    assert.equal(
      (await listTaskScorers(PROJECT, "task-a", db)).some((scorer) => scorer.kind === "judge"),
      false,
    );
  } finally {
    await client.close();
  }
});

test("at the limit with no matching scorer: the change is refused before any write", async () => {
  const { client, db } = await migratedWith(
    `('${PROJECT}', 'task-a', 'max_tool_calls', '{"max": 5}', true, 'user', 'u1')`,
  );
  try {
    // The converted scorer of task-a is gone, and the project is full.
    for (const scorer of await listTaskScorers(PROJECT, "task-a", db))
      await deleteScorer(PROJECT, scorer.id, db);
    await fill(client, MAX_SCORERS);
    const legacy = async () =>
      (await scorersFor(PROJECT, "task-a", db)).find((scorer) => scorer.kind === "max_tool_calls");
    const before = await legacy();
    await assert.rejects(
      saveTaskScorer(
        {
          projectId: PROJECT,
          taskId: "task-a",
          scorer: { kind: "max_tool_calls", max: 3 },
          enabled: true,
          updatedBy: "u1",
        },
        db,
      ),
      ScorerLimitError,
    );
    await assert.rejects(
      resetTaskScorer(PROJECT, "task-a", "max_tool_calls", "u1", db),
      ScorerLimitError,
    );
    assert.deepEqual(await legacy(), before);
    assert.equal(await countScorers(PROJECT, db), MAX_SCORERS);
  } finally {
    await client.close();
  }
});

/** Check scorers of every trace, to bring the project to a count. */
async function fill(client: PGlite, n: number) {
  await client.exec(`insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
    select '${PROJECT}', 'Fast ' || n, 'check', '{"path":"duration_ms","op":"lte","value":1000}', 'u1', 'u1'
    from generate_series(1, ${n}) n`);
}

test("a converted preset that a person deletes does not come back, and the task still gets its other defaults", async () => {
  const { client, db } = await migratedWith(
    `('${PROJECT}', 'task-a', 'max_latency_ms', '{"max": 2000}', true, 'user', 'u1')`,
  );
  try {
    const kinds = async () =>
      (await listTaskScorers(PROJECT, "task-a", db)).map((scorer) =>
        scorer.kind === "preset" ? scorer.config.preset : scorer.kind,
      );
    const [migrated] = await listTaskScorers(PROJECT, "task-a", db);
    await deleteScorer(PROJECT, migrated!.id, db);
    await addRun(client, 1, 1000);
    await seedTaskPresets(PROJECT, new Date(), db);
    const after = await kinds();
    assert.equal(after.includes("max_latency_ms"), false);
    assert.ok(after.includes("ends_well"), after.join());
    // The migration run again adds nothing either.
    const conversion = readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8")
      .split("--> statement-breakpoint")
      .at(-1)!;
    await client.exec(conversion);
    assert.deepEqual((await kinds()).sort(), after.sort());
  } finally {
    await client.close();
  }
});

/** A project with these `task_scorers` rows, then every migration from 0055 on. */
async function migratedWith(rows: string) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const client = new PGlite();
  for (const file of files.slice(0, files.indexOf(MIGRATION))) await client.exec(read(file));
  await client.exec(`
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into task_scorers (project_id, task_id, kind, config, enabled, source, updated_by) values ${rows};`);
  for (const file of files.slice(files.indexOf(MIGRATION))) await client.exec(read(file));
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

test("with the one model on, a queued daily score job writes nothing", async () => {
  const { client, db } = await setup();
  try {
    await addRun(client, 1, 1000);
    const flagDeps = resolveConfig({ override: { flags: { evalGate: true } } });
    const result = await scoreTasksJob(PROJECT, {
      db,
      flagDeps,
      scorersOn: async () => true,
      observability: { trackSystemEvent: async () => {} },
    });
    assert.deepEqual(result, { scored: false, reason: "trace_scorers" });
    assert.deepEqual(await dailyScoresFor(PROJECT, "task-a", db), []);
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

async function addRun(client: PGlite, n: number, durationMs: number) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  const start = new Date(Date.now() - 3_600_000);
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $3, $3, 'declared', 'runtime', 'closed', $4, $5, $5, 'task-a')`,
    [
      id,
      PROJECT,
      `run-${n}`,
      start.toISOString(),
      new Date(start.getTime() + durationMs).toISOString(),
    ],
  );
}
