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
import { enqueueScoreTasksJob } from "@/lib/views/task-scorers/job";

const NOW = new Date("2026-09-02T00:00:00Z");

test("completed signal runs queue task scores only with the eval gate on", async () => {
  const { client, db } = await setupDb();
  try {
    await seedLedger(
      client,
      db,
      times(40, () =>
        fresh().search(["find_task", "assign_task"]).invoke("find_task").invoke("assign_task"),
      ),
    );
    // Owned (ADR-0030): the gate is the configured evalGate flag, not an organization flag.
    let flagDeps = resolveConfig({ override: { flags: { evalGate: false } } });
    const deps = jobDeps(db, NOW, [], {
      enqueueTaskScores: (projectId) => enqueueScoreTasksJob(projectId, { db, flagDeps }),
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
    assert.deepEqual(
      (await listInFlightJobs(PROJECT_ID, db)).map(({ kind, status }) => ({ kind, status })),
      [{ kind: "score_tasks", status: "queued" }],
    );
  } finally {
    await client.close();
  }
});

test("a task score queue failure preserves the completed signal run", async () => {
  const { client, db } = await setupDb();
  try {
    const deps = jobDeps(db, NOW, [], {
      enqueueTaskScores: async () => {
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
