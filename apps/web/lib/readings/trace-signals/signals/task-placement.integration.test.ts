import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
  type Tracked,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";

/**
 * Every run of a signal run's window gets its task in `trace_turns.workflow_id`
 * (the placement `workflow-run.ts` computes), and the stored task counts the
 * same runs the ledger now names.
 */

const NOW = new Date("2026-09-02T00:00:00Z");

function fixtures() {
  return [
    ...times(25, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
    ...times(30, () => fresh().search(["create_task"]).invoke("create_task")),
    ...times(20, () => fresh().search(["list_tasks"])),
  ];
}

test("a signal run writes every run's task, and the stored task counts exactly those runs", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  const tracked: Tracked[] = [];

  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, tracked),
  );
  assert.equal(result.outcome, "completed");

  const run = await latestSignalRun(PROJECT_ID, db, "completed");
  const stored = (run?.summary as { workflows?: StoredWorkflows } | null)?.workflows;
  assert.equal(stored?.items.length, 1);
  const task = stored!.items[0]!;
  assert.deepEqual(task.typicalOrder, ["find_task", "assign_task"]);
  assert.equal(task.reading?.runs, 25);
  assert.deepEqual(
    task.reading?.steps.map((step) => step.toolId),
    ["find_task", "assign_task"],
  );

  const { rows } = await client.query<{ workflow_id: string | null; n: number }>(
    `select workflow_id, count(*)::int as n from trace_turns where project_id = $1 group by 1 order by 1 nulls last`,
    [PROJECT_ID],
  );
  assert.deepEqual(rows, [
    { workflow_id: task.id, n: 25 },
    { workflow_id: null, n: 50 },
  ]);
  const completed = tracked.find((t) => t.event === "trace_signal_run_completed")!.properties;
  assert.equal(completed.runs_placed, 25);
  assert.equal(completed.placement_written, 25);
});

test("the next run over the same ledger writes nothing new", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const tracked: Tracked[] = [];
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "scheduled" }, jobDeps(db, NOW, tracked));
  const completed = tracked.find((t) => t.event === "trace_signal_run_completed")!.properties;
  assert.equal(completed.runs_placed, 25);
  assert.equal(completed.placement_written, 0);
});

test("a failed placement write is reported and the run still completes", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  const tracked: Tracked[] = [];
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, tracked, {
      writePlacement: async () => {
        throw new Error("connection reset");
      },
    }),
  );
  assert.equal(result.outcome, "completed");
  const completed = tracked.find((t) => t.event === "trace_signal_run_completed")!.properties;
  assert.equal(completed.runs_placed, null);
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_turns where workflow_id is not null`,
  );
  assert.equal(rows[0]?.n, 0);
});
