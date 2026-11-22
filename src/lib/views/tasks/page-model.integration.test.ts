import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import { writeTurnPage } from "@/lib/ledger/turns/queries";
import type { TurnEventRow } from "@/lib/ledger/types";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { Organization } from "@/lib/platform/organizations";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { NO_PRICE } from "@/lib/synthesis/tool-crafter/round-trip";
import { buildTaskDetail, buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskExamples, loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

async function seedRun(client: Awaited<ReturnType<typeof setupDb>>["client"]) {
  const summary = {
    version: 1,
    coveredFrom: "2026-09-01",
    daily: [],
    flow: { nodes: [], edges: [] },
    workflows: {
      version: 1,
      turnsWithTools: 40,
      multiToolTurns: 40,
      singleStepTurns: 0,
      assignedTurns: 40,
      truncated: false,
      items: [
        {
          id: "task-a",
          fingerprint: "task-a",
          coreTools: ["find", "assign"],
          optionalTools: [],
          helperTools: [],
          entryTool: "find",
          typicalOrder: ["find", "assign"],
          orderStability: 1,
          runs: 40,
          share: 1,
          health: {
            completion: 1,
            completedRuns: 40,
            failedRuns: 0,
            failingStep: null,
            medianMs: 900,
            p95Ms: 1200,
            slowestStep: null,
            retryRuns: 0,
            errorRuns: 0,
            meanToolCalls: 2,
            turnSourceMix: { declared: 40, inferred: 0, otlp: 0 },
          },
          examples: { failed: [], slow: [], recent: [] },
        },
      ],
    },
  };
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, turns_scanned, summary, finished_at)
     values ($1, 'manual', 'completed', 30, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 50, $2::jsonb, '2026-10-01T00:00:00Z')`,
    [PROJECT_ID, JSON.stringify(summary)],
  );
}

/** The window's segments: `runs` for each task, all inside one stored turn. */
async function seedSegments(
  client: Awaited<ReturnType<typeof setupDb>>["client"],
  runs: Readonly<Record<string, number>>,
) {
  const turn = randomUUID();
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, invoke_count, error_count)
     values ($1, $2, 'sess-1', 'declared:t1', 'declared', 'runtime', 'closed', '2026-09-10T10:00:00Z', '2026-09-10T10:00:05Z', '2026-09-10T10:00:05Z', 2, 0)`,
    [turn, PROJECT_ID],
  );
  for (const [task, n] of Object.entries(runs)) {
    await client.query(
      `insert into task_segments (id, project_id, session_id, workflow_id, start_turn_id, start_ordinal, end_turn_id, end_ordinal, started_at, ended_at, turn_ids, piece_count)
       select gen_random_uuid(), $1, 'sess-1', $2, $3, 1, $3, 2, '2026-09-10T10:00:00Z', '2026-09-10T10:00:05Z', array[$3::uuid], 1 from generate_series(1, $4::int)`,
      [PROJECT_ID, task, turn, n],
    );
  }
}

test("no reading yet: nothing else is read", async () => {
  const { db } = await setupDb();
  const operations: string[] = [];
  const inputs = await loadTasksInputs(PROJECT_ID, {
    read: (operation, read) => (operations.push(operation), read(db as unknown as BoundReadDb)),
  });
  assert.equal(inputs.run, null);
  assert.deepEqual(operations, ["tasks_latest_run"]);
  assert.equal(buildTaskList(inputs).state, "no_reading");
});

test("a failed supplementary read leaves the tasks on the page, that part not measured", async () => {
  const { client, db } = await setupDb();
  await seedRun(client);
  // A task's runs come from its segments; a run of no task is in the window too.
  await seedSegments(client, { "task-a": 40, "task-gone": 10 });
  const inputs = await loadTasksInputs(PROJECT_ID, {
    read: (operation, read) => {
      if (operation === "tasks_topics" || operation === "tasks_open_issues")
        return Promise.reject(new Error("statement timeout"));
      return read(db as unknown as BoundReadDb);
    },
  });
  assert.equal(inputs.run?.turnsScanned, 50);
  assert.equal(inputs.topics, null);
  assert.deepEqual(inputs.issues, []);
  const model = buildTaskList(inputs);
  assert.equal(model.state, "ready");
  assert.deepEqual(
    model.rows.map((row) => [row.id, row.runs, row.share]),
    [["task-a", 40, 0.8]],
  );
});

test("a pending drafted change is read onto the task it composes, with the run's price", async () => {
  const { client, db } = await setupDb();
  await seedRun(client);
  // A task's runs come from its segments (typed steps, ratel-cloud #580).
  await seedSegments(client, { "task-a": 40 });
  await client.query(
    `insert into tool_craft_runs (id, project_id, trigger, status, created_at) values ('55555555-5555-4555-8555-555555555555', $1, 'chained', 'crafted', '2026-10-01T00:00:00Z')`,
    [PROJECT_ID],
  );
  const compose = {
    kind: "compose_chain",
    compose: {
      workflowId: "task-a",
      order: ["find", "assign"],
      runs: 40,
      orderStability: 1,
      medianMs: 900,
      medianModelCalls: null,
      medianCostUsd: null,
    },
  };
  const sources = ["find", "assign"].map((id) => ({
    id,
    name: id,
    description: "",
    searchableDescription: null,
    inputSchema: null,
  }));
  for (const [id, status] of [
    ["66666666-6666-4666-8666-666666666661", "pending"],
    ["66666666-6666-4666-8666-666666666662", "dismissed"],
  ] as const) {
    await client.query(
      `insert into tool_craft_proposals (id, run_id, project_id, kind, status, source_tool_ids, source_definitions, crafted, rationale, evidence, created_at)
       values ($1, '55555555-5555-4555-8555-555555555555', $2, 'compose_chain', $3, '{find,assign}', $4::jsonb, '[]'::jsonb, 'Runs as one chain.', $5::jsonb, '2026-10-01T00:00:00Z')`,
      [id, PROJECT_ID, status, JSON.stringify(sources), JSON.stringify(compose)],
    );
  }
  const operations: string[] = [];
  const inputs = await loadTasksInputs(PROJECT_ID, {
    read: (operation, read) => (operations.push(operation), read(db as unknown as BoundReadDb)),
  });
  assert.ok(
    operations.includes("tasks_pending_fixes"),
    "the crafter's seam is filled, so the drafts are read",
  );
  assert.deepEqual(
    inputs.fixes.map((fix) => [fix.id, fix.kind, fix.workflowId, [...fix.toolIds]]),
    [["66666666-6666-4666-8666-666666666661", "compose_chain", "task-a", ["find", "assign"]]],
    "the dismissed draft is not listed",
  );
  assert.ok(inputs.fixes[0]?.headline.length, "a headline for the task's list");
  assert.deepEqual(
    inputs.price,
    NO_PRICE,
    "no linked model calls in the run: a price of none, not null",
  );
  const model = buildTaskList(inputs);
  assert.equal(model.state, "ready");
});

test("a failed run read is the empty page, not an error page", async () => {
  const inputs = await loadTasksInputs(PROJECT_ID, {
    read: () => Promise.reject(new Error("connection reset")),
  });
  assert.equal(inputs.run, null);
});

test("Fixes' open fixes, or null when Fixes could not be read: the task pages then count the drafts", async () => {
  const organization = { id: "org-1" } as Organization;
  const open = [{ id: "craft:c1" }] as unknown as Awaited<ReturnType<typeof loadTaskFixes>>;
  assert.equal(
    await loadTaskFixes(PROJECT_ID, organization, async () => ({ open: open as never })),
    open,
  );
  assert.equal(
    await loadTaskFixes(PROJECT_ID, organization, () =>
      Promise.reject(new Error("connection reset")),
    ),
    null,
  );
});

test("task inputs read the window's segment counts", async () => {
  const { client, db } = await setupDb();
  await seedRun(client);
  const operations: string[] = [];
  const read: NonNullable<Parameters<typeof loadTasksInputs>[1]>["read"] = (operation, load) => {
    operations.push(operation);
    return load(db as unknown as BoundReadDb);
  };
  const inputs = await loadTasksInputs(PROJECT_ID, { read });
  assert.equal(inputs.segments?.size, 0);
  assert.ok(operations.includes("tasks_segments"));
  await client.close();
});

// Owned: the core's migrations folder, and its task_segments migration is written with IF NOT EXISTS.
test("standard migrations include the stored segments required by the task page", () => {
  const migrations = readMigrationFiles({ migrationsFolder: "lib/platform/db/migrations" });
  assert.ok(
    migrations.some((migration) =>
      migration.sql.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS "task_segments"')),
    ),
  );
});

test("ten stored Stema segments show ten runs with matching calls and examples", async () => {
  const { client, db } = await setupDb();
  try {
    const now = new Date("2026-09-14T00:00:00Z");
    for (let n = 0; n < 10; n++) {
      const spans = typedStepFixtures(Date.parse("2026-09-10T12:00:00Z") + n * 60_000).stema.map(
        (span) => ({ ...span, traceId: (100 + n).toString(16).padStart(32, "0") }),
      );
      const rows = [...deriveSteps(spans), ...deriveModelCalls(spans)].map((row) => ({
        ...row,
        id: randomUUID(),
        receivedAt: row.occurredAt ?? now,
        failed: false,
      }));
      const events = normalizeEvents(rows as unknown as TurnEventRow[], new Map(), {
        salt: "test",
      });
      const { turns } = buildTurns({ stored: [], events, now });
      await writeTurnPage(
        { projectId: PROJECT_ID, turns, orphanedTurnIds: [], through: now.toISOString(), now },
        db,
      );
    }
    const result = await computeProjectTraceSignals(
      PROJECT_ID,
      { trigger: "manual" },
      jobDeps(db, now, []),
    );
    assert.equal(result.outcome, "completed");
    const deps = {
      read: <T>(_operation: string, load: (db: BoundReadDb) => Promise<T>) =>
        load(db as unknown as BoundReadDb),
    };
    const inputs = await loadTasksInputs(PROJECT_ID, deps);
    const list = buildTaskList(inputs);
    assert.equal(list.rows.length, 1);
    const row = list.rows[0];
    assert.ok(row);
    const task = buildTaskDetail(inputs, row.id);
    assert.ok(task);
    assert.equal(task.runs, 10);
    assert.equal(task.callsPerRun, 2); // One model call and one code step per segment.
    assert.equal(task.examples.length, 10);
    const examples = await loadTaskExamples(PROJECT_ID, task, deps);
    assert.equal(examples.size, 10);
    for (const run of examples.values()) {
      assert.equal(run.calls, 2);
      assert.equal(run.traceCount, 1);
      assert.deepEqual(run.steps.map((step) => step.kind).sort(), ["code", "model_call"]);
    }
  } finally {
    await client.close();
  }
});
