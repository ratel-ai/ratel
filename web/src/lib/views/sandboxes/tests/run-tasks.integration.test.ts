import assert from "node:assert/strict";
import { test } from "node:test";
import { linkRunTasks } from "../run-tasks";
import { createSandboxDb, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

const NOW = new Date("2026-11-27T10:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const trace = (n: number) => n.toString(16).padStart(32, "0");

type Run = { n: number; requestedBy?: string; createdAt?: string; project?: string };

async function seed(client: Awaited<ReturnType<typeof createSandboxDb>>["client"], runs: Run[]) {
  for (const [project, sandbox, name] of [
    [PROJECT_ID, id(900), "support-demo"],
    [OTHER_PROJECT_ID, id(901), "other-agent"],
  ] as const) {
    await client.query(`insert into sandboxes (id, project_id, name) values ($1, $2, $3)`, [
      sandbox,
      project,
      name,
    ]);
    await client.query(
      `insert into sandbox_versions (id, project_id, sandbox_id, config, bundle_sha256, bundle_bytes, status)
       values ($1, $2, $3, '{}', 'x', 1, 'ready')`,
      [id(Number.parseInt(sandbox.slice(-3), 10) + 10), project, sandbox],
    );
  }
  for (const run of runs) {
    const project = run.project ?? PROJECT_ID;
    const version = project === PROJECT_ID ? id(910) : id(911);
    const at = run.createdAt ?? "2026-11-27T09:50:00Z";
    await client.query(
      `insert into sandbox_runs (id, project_id, version_id, run_input, status, token_hash, timeout_s, requested_by, trace_id, created_at)
       values ($1, $2, $3, '{}', 'completed', $4, 60, $5, $6, $7)`,
      [id(run.n), project, version, `h${run.n}`, run.requestedBy ?? "user_1", trace(run.n), at],
    );
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at)
       values ($1, $2, 's1', $3, 'otlp', 'otlp', 'closed', $4, $4, $4)`,
      [id(100 + run.n), project, `otlp:${trace(run.n)}`, at],
    );
  }
}

async function tasks(client: Awaited<ReturnType<typeof createSandboxDb>>["client"]) {
  const { rows } = await client.query<{ id: string; workflow_id: string | null }>(
    `select id, workflow_id from trace_turns order by id`,
  );
  return rows.map((row) => row.workflow_id);
}

test("the turn of a sandbox run gets the task of its sandbox; trials, old runs and mined tasks stay", async () => {
  const { client, db } = await createSandboxDb();
  await seed(client, [
    { n: 1 },
    // An eval trial is a run of the eval, not a run of the agent's task.
    { n: 2, requestedBy: "eval_trial:abc" },
    // Older than the window: an earlier sweep linked it, or it stays as it is.
    { n: 3, createdAt: "2026-11-20T00:00:00Z" },
    { n: 4, project: OTHER_PROJECT_ID },
    { n: 5 },
  ]);
  // A task that the signal run mined stays.
  await client.query(`update trace_turns set workflow_id = 'mined' where id = $1`, [id(105)]);

  assert.equal(await linkRunTasks(db, NOW), 2);
  assert.deepEqual(await tasks(client), [
    "sandbox:support-demo",
    null,
    null,
    "sandbox:other-agent",
    "mined",
  ]);
  assert.equal(await linkRunTasks(db, NOW), 0, "a second sweep writes nothing");
});
