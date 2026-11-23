import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { taskEvalCases } from "@/lib/views/task-evals/schema";
import { changeTaskEval, type TaskEvalActionDeps, type TaskEvalChangeEvent } from "./actions";
import { taskEvalSetFor } from "./store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const FOREIGN_TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const NOW = new Date("2026-11-01T12:00:00Z");

test("a member adds a run by trace or turn, pins, unpins, excludes and queues a refresh", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const events: TaskEvalChangeEvent[] = [];
  const queued: unknown[] = [];
  const deps: TaskEvalActionDeps = {
    db,
    getSession: async () => ({ user: { id: "db-user", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: "org-test" } }),
    enabled: async () => true,
    enqueue: async (...args) => {
      queued.push(args);
      return { id: "job-test" };
    },
    observe: async (fields) => {
      events.push(fields);
    },
    now: () => NOW,
  };
  const act = (command: Record<string, unknown>) =>
    changeTaskEval({ projectId: PROJECT, taskId: "task-a", ...command }, deps);
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values
        ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent'),
        ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
        ('${TURN}', '${PROJECT}', 'test', 'test', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a'),
        ('${FOREIGN_TURN}', '${OTHER}', 'foreign', 'foreign', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a');
      insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, payload) values
        ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', '${PROJECT}', 'invoke_end', 'test', now(), now(), 'test', 'trace-test', '{}');
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome) values
        ('${TURN}', '${PROJECT}', 1, 'invoke', 'invoke_end', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', now(), now(), 'tool', 'notify', 'ok');
    `);
    assert.equal((await act({ action: "add", runId: " trace-test " })).ok, true);
    let result = await taskEvalSetFor(PROJECT, "task-a", db);
    assert.equal(result.cases.length, 1);
    const row = result.cases[0]!;
    assert.equal(row.origin, "user");
    assert.equal(row.turnId, TURN);
    assert.equal(row.selectionReason, "Added by you.");
    assert.equal((await act({ action: "add", runId: TURN })).ok, true);
    assert.equal(
      (await taskEvalSetFor(PROJECT, "task-a", db)).cases.length,
      1,
      "Repeated adds remain unique.",
    );
    assert.equal((await act({ action: "pin", caseId: row.id })).ok, true);
    assert.equal((await taskEvalSetFor(PROJECT, "task-a", db)).cases[0]!.pinned, true);
    assert.equal((await act({ action: "unpin", caseId: row.id })).ok, true);
    assert.equal((await taskEvalSetFor(PROJECT, "task-a", db)).cases[0]!.pinned, false);
    assert.equal((await act({ action: "exclude", caseId: row.id })).ok, true);
    assert.equal(
      (await taskEvalSetFor(PROJECT, "task-a", db)).cases[0]!.excludedAt?.toISOString(),
      NOW.toISOString(),
    );
    assert.equal(
      (await act({ action: "pin", caseId: row.id })).ok,
      false,
      "Excluded cases cannot be pinned.",
    );
    assert.equal(
      (await act({ action: "add", runId: TURN })).ok,
      true,
      "Explicitly adding an excluded run restores it.",
    );
    result = await taskEvalSetFor(PROJECT, "task-a", db);
    assert.equal(result.cases[0]!.excludedAt, null);
    assert.equal(result.cases[0]!.id, row.id);

    const eventCount = events.length;
    for (const command of [
      { action: "add", runId: FOREIGN_TURN },
      { action: "add", runId: "missing-trace" },
      { action: "pin", taskId: "task-b", caseId: row.id },
    ])
      assert.equal((await act(command)).ok, false);
    await db.insert(taskEvalCases).values({
      projectId: PROJECT,
      taskId: "task-a",
      turnId: TURN,
      origin: "fix",
      fixId: "rewrite:test",
    });
    const fixCase = (await taskEvalSetFor(PROJECT, "task-a", db)).cases.find(
      (item) => item.fixId !== null,
    )!;
    assert.equal(
      (await act({ action: "exclude", caseId: fixCase.id })).ok,
      false,
      "The task editor cannot change fix cases.",
    );
    await client.exec(`update trace_turns set status = 'open' where id = '${TURN}'`);
    assert.equal(
      (await act({ action: "add", runId: TURN })).ok,
      false,
      "Open runs cannot enter the eval set.",
    );
    assert.equal(events.length, eventCount, "Rejected changes emit no success event.");
    assert.equal((await act({ action: "refresh" })).ok, true);
    assert.deepEqual(queued, [[PROJECT, "task-a"]]);
    assert.deepEqual(events.at(-1), {
      project_id: PROJECT,
      organization_id: "org-test",
      task_id: "task-a",
      actor: "user_test",
      action: "refresh",
    });
    deps.enqueue = async () => null;
    assert.equal((await act({ action: "refresh" })).ok, false);
    assert.equal(events.length, eventCount + 1);
  } finally {
    await client.close();
  }
});
