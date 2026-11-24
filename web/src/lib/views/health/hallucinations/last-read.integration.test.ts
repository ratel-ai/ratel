import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { loadLastRead } from "@/lib/views/health/hallucinations/page-queries";

async function addRun(
  client: Awaited<ReturnType<typeof setupDb>>["client"],
  summary: object,
  createdAt: string,
  status = "completed",
) {
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, summary, created_at)
     values ($1, 'sweep', $2, 7, $3::timestamptz - interval '7 days', $3, $4, $3)`,
    [PROJECT_ID, status, createdAt, JSON.stringify(summary)],
  );
}

test("the last read is the newest run that read hallucinations, not the newest run", async () => {
  const { client, db } = await setupDb();
  const alias = {
    requestedToolId: "get_task",
    toolId: "entity_lookup",
    calls: 6,
    sessions: 3,
    worked: 6,
  };
  await addRun(
    client,
    { hallucinations: { findings: 2, aliases: [alias] } },
    "2026-09-01T00:00:00Z",
  );
  // The next run's reading failed or ran out of time: its summary has no hallucinations.
  await addRun(client, { outcomes: {} }, "2026-09-02T00:00:00Z");
  // A run still going says nothing yet.
  await addRun(
    client,
    { hallucinations: { findings: 0, aliases: [] } },
    "2026-09-03T00:00:00Z",
    "running",
  );

  const last = await loadLastRead(PROJECT_ID, db as never);
  assert.equal(last.at?.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.deepEqual(last.aliases, [alias]);
});

test("a project no run has read hallucinations for is not read yet", async () => {
  const { client, db } = await setupDb();
  await addRun(client, { outcomes: {} }, "2026-09-02T00:00:00Z");
  assert.deepEqual(await loadLastRead(PROJECT_ID, db as never), { at: null, aliases: [] });
});
