import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { writeTaskPlacement } from "@/lib/readings/trace-signals/workflows/place-queries";

const WINDOW = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") };

async function seedTurns(
  client: Awaited<ReturnType<typeof setupDb>>["client"],
  rows: { id: string; endedAt: string; workflowId: string | null; status?: string }[],
) {
  for (const [i, row] of rows.entries()) {
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, 's1', $3, 'declared', 'runtime', $4, $5, $5, $5, $6)`,
      [row.id, PROJECT_ID, `declared:t${i}`, row.status ?? "closed", row.endedAt, row.workflowId],
    );
  }
}

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

async function placements(
  client: Awaited<ReturnType<typeof setupDb>>["client"],
): Promise<Record<string, string | null>> {
  const { rows } = await client.query<{ id: string; workflow_id: string | null }>(
    `select id, workflow_id from trace_turns order by id`,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.workflow_id]));
}

test("a signal run writes each run's task and clears the window's runs it placed in none", async () => {
  const { client, db } = await setupDb();
  await seedTurns(client, [
    { id: id(1), endedAt: "2026-09-10T00:00:00Z", workflowId: null },
    { id: id(2), endedAt: "2026-09-11T00:00:00Z", workflowId: "old-task" },
    { id: id(3), endedAt: "2026-09-12T00:00:00Z", workflowId: "task-b" },
    // In the window, but the run did not read it (a guessed run under an exact basis, or past the cap).
    { id: id(4), endedAt: "2026-09-13T00:00:00Z", workflowId: "old-task" },
    // Outside the window: an older run's answer stands.
    { id: id(5), endedAt: "2026-08-01T00:00:00Z", workflowId: "old-task" },
  ]);
  const placement = new Map<string, string | null>([
    [id(1), "task-a"],
    [id(2), null],
    [id(3), "task-b"],
  ]);

  const first = await writeTaskPlacement(PROJECT_ID, { window: WINDOW, placement }, db);
  assert.deepEqual(first, { placed: 2, set: 1, cleared: 2 });
  assert.deepEqual(await placements(client), {
    [id(1)]: "task-a",
    [id(2)]: null,
    [id(3)]: "task-b",
    [id(4)]: null,
    [id(5)]: "old-task",
  });

  const again = await writeTaskPlacement(PROJECT_ID, { window: WINDOW, placement }, db);
  assert.deepEqual(
    again,
    { placed: 2, set: 0, cleared: 0 },
    "a rerun of the same reading writes nothing",
  );
});

test("thousands of runs are written in chunks, and another project's runs are never touched", async () => {
  const { client, db } = await setupDb();
  const other = "33333333-3333-4333-8333-333333333333";
  await client.exec(
    `insert into projects (id, organization_id, name, slug) values ('${other}', '22222222-2222-4222-8222-222222222222', 'Other', 'other')`,
  );
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 's1', 'declared:t' || n, 'declared', 'runtime', 'closed',
            '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', null
     from generate_series(1, 2500) as n`,
    [PROJECT_ID],
  );
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ('99999999-0000-4000-8000-000000000001', $1, 's1', 'declared:x', 'declared', 'runtime', 'closed', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', 'theirs')`,
    [other],
  );
  const placement = new Map(
    Array.from({ length: 2500 }, (_, i) => [id(i + 1), i % 2 === 0 ? "even" : "odd"] as const),
  );
  const result = await writeTaskPlacement(
    PROJECT_ID,
    { window: WINDOW, placement: new Map(placement) },
    db,
  );
  assert.deepEqual(result, { placed: 2500, set: 2500, cleared: 0 });
  const { rows } = await client.query<{ workflow_id: string; n: number }>(
    `select workflow_id, count(*)::int as n from trace_turns group by 1 order by 1`,
  );
  assert.deepEqual(rows, [
    { workflow_id: "even", n: 1250 },
    { workflow_id: "odd", n: 1250 },
    { workflow_id: "theirs", n: 1 },
  ]);
});
