import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { Organization } from "@/lib/platform/identity/schema";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { NO_PRICE } from "@/lib/synthesis/tool-crafter/round-trip";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

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
