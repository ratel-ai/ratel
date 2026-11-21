import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { changeTaskEval, type TaskEvalActionDeps } from "./actions";
import { taskEvalSetFor } from "./store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const proposal = {
  name: "Check a delivery",
  ask: "Track the steel delivery.",
  expected: {
    tool: "track_delivery",
    maxToolCalls: 3,
    maxSelfCorrections: 0,
    maxLatencyMs: 5000,
    maxCostUsd: 0.05,
  },
  criteria: "Return the arrival date.",
};

test("Save stores the edited proposal as a user case and refuses duplicate saves", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const events: unknown[] = [];
  const deps: TaskEvalActionDeps = {
    db,
    getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: "org-test" } }),
    enabled: async () => true,
    enqueue: async () => null,
    observe: async (fields) => {
      events.push(fields);
    },
  };
  const save = (value = proposal, taskId = "task-a") =>
    changeTaskEval(
      { action: "add", projectId: PROJECT, taskId, runId: TURN, proposal: value },
      deps,
    );
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent');
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
        values ('${TURN}', '${PROJECT}', 'run', 'run', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a');
    `);
    assert.equal((await save()).ok, true);
    const [row] = (await taskEvalSetFor(PROJECT, "task-a", db)).cases;
    assert.equal(row!.origin, "user");
    assert.equal(row!.criteria, proposal.criteria);
    assert.deepEqual(row!.expected, proposal.expected);
    assert.equal(row!.testName, proposal.name);
    assert.equal(row!.testAsk, proposal.ask);
    assert.equal(row!.selectionReason, "Added by you.");
    assert.deepEqual(await save({ ...proposal, criteria: "Overwrite" }), {
      ok: false,
      error: "This run is already in the eval set.",
    });
    assert.equal(
      (await taskEvalSetFor(PROJECT, "task-a", db)).cases[0]!.criteria,
      proposal.criteria,
    );
    assert.equal(events.length, 1);
    assert.equal((await save(proposal, "task-b")).ok, false);
    for (const refusal of ["session", "membership", "flag"]) {
      const denied = { ...deps };
      if (refusal === "session") denied.getSession = async () => null;
      if (refusal === "membership") denied.findProjectScope = async () => null;
      if (refusal === "flag") denied.enabled = async () => false;
      assert.equal(
        (
          await changeTaskEval(
            { action: "add", projectId: PROJECT, taskId: "task-a", runId: TURN, proposal },
            denied,
          )
        ).ok,
        false,
      );
    }
    assert.equal(
      (await save({ ...proposal, expected: { ...proposal.expected, maxToolCalls: -1 } })).ok,
      false,
    );
  } finally {
    await client.close();
  }
});
