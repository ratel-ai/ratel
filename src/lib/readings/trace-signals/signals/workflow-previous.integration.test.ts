import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { loadAnalysisContext } from "@/lib/readings/trace-signals/signals/analysis-context";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { loadPreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";

/**
 * Last run's workflows against a real schema: only the project's latest
 * completed run counts (a running or failed one never does), and a summary
 * without workflows, or with junk in their place, reads as none.
 */

const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const WINDOW = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };

async function insertRun(
  client: PGlite,
  opts: { at: string; status: string; summary: unknown; project?: string },
) {
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary, created_at)
     values ($1, 'scheduled', $2, 30, $3, $4, $5::jsonb, $6)`,
    [
      opts.project ?? PROJECT_ID,
      opts.status,
      WINDOW.start.toISOString(),
      WINDOW.end.toISOString(),
      JSON.stringify(opts.summary),
      opts.at,
    ],
  );
}

const summaryWith = (items: unknown) => ({
  version: 1,
  daily: [],
  workflows: { version: 1, items },
});

test("previous workflows come from the latest completed run of this project only", async () => {
  const { client, db } = await setupDb();
  await client.exec(`insert into projects (id, organization_id, name, slug)
    select '${OTHER_PROJECT}', organization_id, 'Other', 'other' from projects where id = '${PROJECT_ID}'`);
  assert.deepEqual(await loadPreviousWorkflows(PROJECT_ID, db), [], "no run yet");

  await insertRun(client, {
    at: "2026-09-01T00:00:00Z",
    status: "completed",
    summary: summaryWith([{ id: "old", coreTools: ["a", "b"] }]),
  });
  await insertRun(client, {
    at: "2026-09-02T00:00:00Z",
    status: "completed",
    summary: summaryWith([{ id: "wf-1", coreTools: ["c", "b", "a"], runs: 40 }]),
  });
  await insertRun(client, {
    at: "2026-09-03T00:00:00Z",
    status: "failed",
    summary: summaryWith([{ id: "failed", coreTools: ["x", "y"] }]),
  });
  await insertRun(client, { at: "2026-09-04T00:00:00Z", status: "running", summary: null });
  await insertRun(client, {
    at: "2026-09-05T00:00:00Z",
    status: "completed",
    summary: summaryWith([{ id: "other", coreTools: ["z", "w"] }]),
    project: OTHER_PROJECT,
  });

  assert.deepEqual(await loadPreviousWorkflows(PROJECT_ID, db), [
    { id: "wf-1", coreTools: ["a", "b", "c"] },
  ]);
  const { context } = await loadAnalysisContext(PROJECT_ID, WINDOW, db);
  assert.deepEqual(
    context.previousWorkflows,
    [{ id: "wf-1", coreTools: ["a", "b", "c"] }],
    "the run context carries them",
  );
});

test("a latest run stored before workflows, or with junk in their place, reads as none", async () => {
  const { client, db } = await setupDb();
  await insertRun(client, {
    at: "2026-09-01T00:00:00Z",
    status: "completed",
    summary: summaryWith([{ id: "old", coreTools: ["a", "b"] }]),
  });
  await insertRun(client, {
    at: "2026-09-02T00:00:00Z",
    status: "completed",
    summary: { version: 1, daily: [] },
  });
  assert.deepEqual(
    await loadPreviousWorkflows(PROJECT_ID, db),
    [],
    "the latest run had no workflows",
  );
  await insertRun(client, {
    at: "2026-09-03T00:00:00Z",
    status: "completed",
    summary: { workflows: { items: "not a list" } },
  });
  assert.deepEqual(await loadPreviousWorkflows(PROJECT_ID, db), []);
});

test("a failed read is reported and treated as no previous workflows", async () => {
  const { client, db } = await setupDb();
  await client.exec(`alter table trace_signal_runs rename to trace_signal_runs_gone`);
  assert.deepEqual(await loadPreviousWorkflows(PROJECT_ID, db), []);
});
