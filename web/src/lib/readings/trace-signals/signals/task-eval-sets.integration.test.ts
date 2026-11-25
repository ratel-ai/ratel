import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { listInFlightJobs } from "@/lib/jobs/queries";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { enqueueDueTaskEvalSets } from "@/lib/views/task-evals/job";

const NOW = new Date("2026-09-02T00:00:00Z");

test("completed signal runs queue the due eval sets only with the eval gate on", async () => {
  const { client, db } = await setupDb();
  try {
    await seedLedger(
      client,
      db,
      times(40, () =>
        fresh().search(["find_task", "assign_task"]).invoke("find_task").invoke("assign_task"),
      ),
    );
    // Owned (ADR-0004): the gate is the configured evalGate flag, not an organization flag.
    let flagDeps = resolveConfig({ override: { flags: { evalGate: false } } });
    const deps = jobDeps(db, NOW, [], {
      enqueueTaskEvalSets: (projectId) => enqueueDueTaskEvalSets(projectId, { db, flagDeps }),
    });
    assert.equal(
      (await computeProjectTraceSignals(PROJECT_ID, { trigger: "scheduled" }, deps)).outcome,
      "completed",
    );
    assert.deepEqual(await listInFlightJobs(PROJECT_ID, db), []);

    flagDeps = resolveConfig({ override: { flags: { evalGate: true } } });
    assert.equal(
      (await computeProjectTraceSignals(PROJECT_ID, { trigger: "scheduled" }, deps)).outcome,
      "completed",
    );
    const queued = await listInFlightJobs(PROJECT_ID, db);
    assert.ok(queued.length > 0);
    assert.ok(queued.every(({ kind }) => kind === "refresh_task_eval_set"));
  } finally {
    await client.close();
  }
});

test("an eval set queue failure preserves the completed signal run", async () => {
  const { client, db } = await setupDb();
  try {
    const deps = jobDeps(db, NOW, [], {
      enqueueTaskEvalSets: async () => {
        throw new Error("test queue unavailable");
      },
    });
    assert.equal(
      (await computeProjectTraceSignals(PROJECT_ID, { trigger: "scheduled" }, deps)).outcome,
      "completed",
    );
    assert.equal((await latestSignalRun(PROJECT_ID, db))?.status, "completed");
  } finally {
    await client.close();
  }
});
