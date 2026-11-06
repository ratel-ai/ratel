import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { scoreTasksJob } from "@/lib/views/task-scorers/job";
import { taskScoresDaily } from "@/lib/views/task-scorers/schema";
import { dailyScoresFor, upsertScorer } from "@/lib/views/task-scorers/store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-01T12:00:00Z");
// Owned (ADR-0030): the gate is FF_EVAL_GATE from the environment, not an organization flag.
const FLAGS_ON: OrganizationFlagDeps = { FF_EVAL_GATE: "1" };

test("the score job writes nothing when the eval gate is off", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, durationMs: 1000 });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Call notify." },
        updatedBy: "test",
      },
      db,
    );
    const flagDeps: OrganizationFlagDeps = { FF_EVAL_GATE: "0" };
    assert.deepEqual(
      await scoreTasksJob(PROJECT, {
        db,
        flagDeps,
        now: () => NOW,
        judge: {
          model: "claude-sonnet-4-6",
          standIn: false,
          judge: async () => assert.fail("The disabled gate must prevent the judge call."),
        },
      }),
      { scored: false, reason: "gate_off" },
    );
    assert.deepEqual(await dailyScoresFor(PROJECT, "task-a", db), []);
  } finally {
    await client.close();
  }
});

test("closed fixture runs produce daily counts, fill missed days and remain stable on retry", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, day: "2026-10-30", durationMs: 1000 });
    await seedRun(client, { n: 2, day: "2026-10-30", durationMs: 3000, outcome: "error" });
    await seedRun(client, { n: 3, durationMs: 2000 });
    await seedRun(client, { n: 4, durationMs: 9000, status: "open" });
    await seedRun(client, { n: 5, durationMs: 9000, project: OTHER_PROJECT });
    await seedRun(client, { n: 6, durationMs: 5000, task: "task-b" });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 2000 },
        updatedBy: "user_test",
      },
      db,
    );
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_cost_usd", max: 1 },
        updatedBy: "user_test",
      },
      db,
    );
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 0 },
        enabled: false,
        updatedBy: "user_test",
      },
      db,
    );

    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: { trackSystemEvent: async () => undefined },
    };
    const result = await scoreTasksJob(PROJECT, deps);
    assert.equal(result.scored, true);
    const rows = await dailyScoresFor(PROJECT, "task-a", db);
    assert.deepEqual(
      rows
        .filter((row) => row.scorerKind === "overall")
        .map(({ day, n, passed, scorerVersion }) => ({ day, n, passed, scorerVersion })),
      [
        { day: "2026-10-30", n: 2, passed: 1, scorerVersion: 1 },
        { day: "2026-10-31", n: 0, passed: 0, scorerVersion: 1 },
        { day: "2026-11-01", n: 1, passed: 1, scorerVersion: 1 },
      ],
    );
    assert.deepEqual(
      rows
        .filter((row) => row.day === "2026-10-30")
        .map(({ scorerKind, n, passed }) => ({ scorerKind, n, passed })),
      [
        { scorerKind: "ends_well", n: 2, passed: 1 },
        { scorerKind: "max_cost_usd", n: 0, passed: 0 },
        { scorerKind: "max_latency_ms", n: 2, passed: 1 },
        { scorerKind: "max_self_corrections", n: 2, passed: 1 },
        { scorerKind: "overall", n: 2, passed: 1 },
      ],
    );
    assert.equal(
      (await dailyScoresFor(PROJECT, "task-b", db)).find((row) => row.scorerKind === "overall")?.n,
      1,
    );
    assert.deepEqual(await dailyScoresFor(OTHER_PROJECT, "task-a", db), []);
    await scoreTasksJob(PROJECT, deps);
    assert.deepEqual(await dailyScoresFor(PROJECT, "task-a", db), rows);
  } finally {
    await client.close();
  }
});

test("a threshold change affects the next day and the job completes the last partial day", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, durationMs: 2000 });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 3000 },
        updatedBy: "user_test",
      },
      db,
    );
    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: { trackSystemEvent: async () => undefined },
    };
    await scoreTasksJob(PROJECT, deps);
    const before = (await dailyScoresFor(PROJECT, "task-a", db)).find(
      (row) => row.scorerKind === "overall",
    );
    assert.equal(before?.passed, 1);

    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 1000 },
        updatedBy: "user_test",
      },
      db,
    );
    await seedRun(client, { n: 2, durationMs: 2000 });
    await seedRun(client, { n: 3, day: "2026-11-02", durationMs: 2000 });
    await scoreTasksJob(PROJECT, { ...deps, now: () => new Date("2026-11-02T12:00:00Z") });
    const rows = await dailyScoresFor(PROJECT, "task-a", db);
    assert.equal(
      rows.find((row) => row.day === "2026-11-01" && row.scorerKind === "overall")?.n,
      2,
      "the previous reading did not include the later run",
    );
    assert.deepEqual(
      rows
        .filter((row) => row.day === "2026-11-02" && row.scorerKind === "max_latency_ms")
        .map(({ n, passed }) => ({ n, passed })),
      [{ n: 1, passed: 0 }],
    );
    assert.equal(
      rows.find((row) => row.day === "2026-11-02" && row.scorerKind === "overall")?.passed,
      0,
    );
  } finally {
    await client.close();
  }
});

test("the job reports task identities with scorers and no run in seven days", async () => {
  const { client, db } = await setup();
  try {
    await seedRun(client, { n: 1, durationMs: 2000 });
    await seedRun(client, { n: 2, day: "2026-10-20", durationMs: 2000, task: "task-old" });
    for (const taskId of ["task-a", "task-old", "task-gone"]) {
      await upsertScorer(
        { projectId: PROJECT, taskId, scorer: { kind: "ends_well" }, updatedBy: "user_test" },
        db,
      );
    }
    await upsertScorer(
      {
        projectId: OTHER_PROJECT,
        taskId: "task-other",
        scorer: { kind: "ends_well" },
        updatedBy: "user_test",
      },
      db,
    );
    const result = await scoreTasksJob(PROJECT, {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: { trackSystemEvent: async () => undefined },
    });
    assert.ok("orphaned" in result);
    assert.equal(result.orphaned, 2);
    assert.deepEqual(await dailyScoresFor(PROJECT, "task-gone", db), []);
  } finally {
    await client.close();
  }
});

test("each task day keeps its newest 500 closed runs and reports truncation", async () => {
  const { client, db } = await setup();
  try {
    await client.exec(`
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      select md5('volume-' || g)::uuid, '${PROJECT}', 'volume-' || g, 'volume-' || g, 'declared', 'runtime', 'closed',
        '2026-11-01T10:00:00Z'::timestamptz + g * interval '1 millisecond',
        '2026-11-01T10:00:01Z'::timestamptz + g * interval '1 millisecond',
        '2026-11-01T10:00:01Z'::timestamptz + g * interval '1 millisecond', 'task-a'
      from generate_series(1, 501) g;
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
      select md5('volume-' || g)::uuid, '${PROJECT}', 1, 'invoke', 'invoke_end', gen_random_uuid(),
        '2026-11-01T10:00:00Z'::timestamptz, '2026-11-01T10:00:00Z'::timestamptz, 'tool', 'notify',
        case when g = 1 then 'error' else 'ok' end
      from generate_series(1, 501) g;
    `);
    await seedRun(client, { n: 1, day: "2026-10-31", durationMs: 1000, outcome: "error" });
    await seedRun(client, { n: 2, durationMs: 1000, task: "task-b" });
    const events: Record<string, unknown>[] = [];
    const result = await scoreTasksJob(PROJECT, {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: {
        trackSystemEvent: async (event, actor, fields) => {
          assert.equal(event, "task_scores_written");
          assert.equal(actor, "system:task-scorers");
          events.push(fields);
        },
      },
    });
    assert.ok("truncated" in result);
    assert.equal(result.truncated, true);
    assert.equal(result.runs, 502);
    assert.deepEqual(
      (await dailyScoresFor(PROJECT, "task-a", db))
        .filter((row) => row.scorerKind === "overall")
        .map(({ day, n, passed }) => ({ day, n, passed })),
      [
        { day: "2026-10-31", n: 1, passed: 0 },
        { day: "2026-11-01", n: 500, passed: 500 },
      ],
    );
    assert.equal(
      (await dailyScoresFor(PROJECT, "task-b", db)).find((row) => row.scorerKind === "overall")?.n,
      1,
    );
    assert.equal(events[0]?.truncated, true);
    assert.equal(events[0]?.runs, 502);
    assert.equal(events[0]?.project_id, PROJECT);
    assert.equal(events[0]?.tasks, 2);
    assert.equal(events[0]?.rows, 12);
    assert.equal(typeof events[0]?.duration_ms, "number");
  } finally {
    await client.close();
  }
});

test("the live judge samples at most 20 runs across retries and keeps a separate series", async () => {
  const { client, db } = await setup();
  try {
    for (let n = 1; n <= 25; n++) await seedRun(client, { n, durationMs: 1000 });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "judge_criteria", criteria: "Call notify." },
        updatedBy: "test",
      },
      db,
    );
    let calls = 0;
    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      observability: { trackSystemEvent: async () => undefined },
      judge: {
        model: "claude-sonnet-4-6",
        standIn: false,
        judge: async ({ criteria }: { criteria: string; run: string }) => {
          assert.equal(criteria, "Call notify.");
          calls++;
          return { pass: calls % 2 === 0, usage: { inputTokens: 100, outputTokens: 10 } };
        },
      },
    };
    await scoreTasksJob(PROJECT, deps);
    await scoreTasksJob(PROJECT, deps);
    const rows = await dailyScoresFor(PROJECT, "task-a", db);
    const judged = rows.find((row) => row.scorerKind === "judge_criteria");
    assert.equal(calls, 20);
    assert.equal(judged?.n, 20);
    assert.equal(judged?.passed, 10);
    assert.ok(Number(judged?.judgeSpend?.usd) > 0);
    assert.equal(rows.find((row) => row.scorerKind === "overall")?.n, 25);
    assert.equal(rows.find((row) => row.scorerKind === "overall")?.passed, 25);
  } finally {
    await client.close();
  }
});

test("the live judge refuses the organization judge cap and shared daily cap", async () => {
  for (const budget of [
    { judgeBudgetUsd: 0.5, dailyBudgetUsd: 10 },
    { judgeBudgetUsd: 1, dailyBudgetUsd: 0.5 },
  ]) {
    const { client, db } = await setup();
    try {
      await seedRun(client, { n: 1, durationMs: 1000 });
      await upsertScorer(
        {
          projectId: PROJECT,
          taskId: "task-a",
          scorer: { kind: "judge_criteria", criteria: "Call notify." },
          updatedBy: "test",
        },
        db,
      );
      await db.insert(taskScoresDaily).values({
        projectId: OTHER_PROJECT,
        taskId: "other-task",
        day: "2026-11-01",
        scorerKind: "judge_criteria",
        scorerVersion: 1,
        n: 1,
        passed: 1,
        judgeSpend: { usd: 0.5, runIds: ["other"] },
      });
      await scoreTasksJob(PROJECT, {
        db,
        flagDeps: FLAGS_ON,
        now: () => NOW,
        ...budget,
        judge: {
          model: "claude-sonnet-4-6",
          standIn: false,
          judge: async () => assert.fail("The budget must refuse the model call."),
        },
        observability: { trackSystemEvent: async () => undefined },
      });
      const rows = await dailyScoresFor(PROJECT, "task-a", db);
      assert.equal(rows.find((row) => row.scorerKind === "overall")?.n, 1);
      assert.equal(rows.find((row) => row.scorerKind === "judge_criteria")?.n ?? 0, 0);
    } finally {
      await client.close();
    }
  }
});

test("live judge reservations protect other projects and settle actual organization spend", {
  timeout: 60_000,
}, async () => {
  const { client, db } = await setup();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let running: Promise<unknown> | undefined;
  try {
    await seedRun(client, { n: 1, durationMs: 1000 });
    await seedRun(client, { n: 2, durationMs: 1000, project: OTHER_PROJECT });
    for (const projectId of [PROJECT, OTHER_PROJECT]) {
      await upsertScorer(
        {
          projectId,
          taskId: "task-a",
          scorer: { kind: "judge_criteria", criteria: "Call notify." },
          updatedBy: "test",
        },
        db,
      );
    }
    const deps = {
      db,
      flagDeps: FLAGS_ON,
      now: () => NOW,
      judgeBudgetUsd: 0.1,
      dailyBudgetUsd: 0.1,
      observability: { trackSystemEvent: async () => undefined },
      judge: {
        model: "claude-sonnet-4-6",
        standIn: false,
        judge: async () => {
          start();
          await barrier;
          return { pass: true, usage: { inputTokens: 100, outputTokens: 10 } };
        },
      },
    };
    running = scoreTasksJob(PROJECT, deps);
    await started;
    assert.equal(
      await organizationModelSpendSince(OTHER_PROJECT, new Date("2026-11-01T00:00:00Z"), db),
      0.1,
    );
    await scoreTasksJob(OTHER_PROJECT, {
      ...deps,
      judge: {
        ...deps.judge,
        judge: async () => assert.fail("The active reservation must block this project."),
      },
    });
    release();
    await running;
    const spent = await organizationModelSpendSince(
      OTHER_PROJECT,
      new Date("2026-11-01T00:00:00Z"),
      db,
    );
    assert.ok(Math.abs(spent - 0.00045) < 1e-9);
  } finally {
    release();
    await running;
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
  input: {
    n: number;
    durationMs: number;
    day?: string;
    task?: string;
    project?: string;
    status?: string;
    outcome?: string;
  },
) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(input.n).padStart(12, "0")}`;
  const start = new Date(`${input.day ?? "2026-11-01"}T10:00:00Z`);
  const end = new Date(start.getTime() + input.durationMs);
  const project = input.project ?? PROJECT;
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $7, $7, 'declared', 'runtime', $3, $4, $5, $5, $6)`,
    [
      id,
      project,
      input.status ?? "closed",
      start.toISOString(),
      end.toISOString(),
      input.task ?? "task-a",
      `run-${input.n}`,
    ],
  );
  await client.query(
    `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
     values ($1, $2, 1, 'invoke', 'invoke_end', gen_random_uuid(), $3, $3, 'tool', 'notify', $4)`,
    [id, project, start.toISOString(), input.outcome ?? "ok"],
  );
}
