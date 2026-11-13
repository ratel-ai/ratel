import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { latestFixDraft } from "@/lib/views/fix-drafts/store";
import { buildFixes } from "@/lib/views/fixes/build";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import "@/lib/views/task-evals/ship";
import { fixShipments } from "@/lib/views/fixes/schema";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import { taskEvalRuns } from "@/lib/views/task-evals/schema";
import {
  changeTaskSimulation,
  type TaskSimulationActionDeps,
  type TaskSimulationEditEvent,
} from "@/lib/views/task-evals/simulation-actions";
import { taskEvalSetFor } from "@/lib/views/task-evals/store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";

test("members save user drafts, add and edit fix tests, and rerun through the simulation API", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const original = buildFixes(fixesInput()).open.find((fix) => fix.source === "rewrite")!;
  const fix = {
    ...original,
    issues: [],
    subject: {
      ...original.subject,
      tasks: ["task-a", "task-b"].map((id) => ({ id, label: id, href: "", color: null })),
    },
  };
  const events: TaskSimulationEditEvent[] = [];
  const runs: unknown[] = [];
  const deps: TaskSimulationActionDeps = {
    db,
    getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: "org" } }),
    enabled: async () => true,
    loadFix: async (_project, id) => (id === fix.id ? { projectId: PROJECT, fix } : null),
    run: async (...args) => {
      runs.push(args);
      return { status: "queued" };
    },
    observe: async (fields) => {
      events.push(fields);
    },
  };
  const act = (command: Record<string, unknown>) =>
    changeTaskSimulation({ projectId: PROJECT, taskId: "task-a", fixId: fix.id, ...command }, deps);
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values
        ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent'),
        ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id) values
        ('${TURN}', '${PROJECT}', 'test', 'test', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a'),
        ('${FOREIGN}', '${OTHER}', 'foreign', 'foreign', 'declared', 'runtime', 'closed', now(), now(), now(), 'task-a');
      insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, payload) values
        ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', '${PROJECT}', 'invoke_end', 'test', now(), now(), 'test', 'trace-one', '{}');
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome) values
        ('${TURN}', '${PROJECT}', 1, 'invoke', 'invoke_end', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', now(), now(), 'tool', 'search', 'ok');
    `);
    const change = { ...emptyChange(), patches: { search: "Find the invoice by its number." } };
    assert.deepEqual(await act({ action: "draft", change }), { ok: true, message: "Draft saved." });
    const draft = await latestFixDraft(PROJECT, fix.id, db);
    assert.equal(draft?.origin, "user");
    assert.equal(draft?.createdBy, "user_test");
    assert.deepEqual(draft?.change, change);
    assert.equal(
      (
        await act({
          action: "add-test",
          runId: "trace-one",
          expected: { tool: "search", maxToolCalls: 2 },
          criteria: "Find the invoice.",
        })
      ).ok,
      true,
    );
    let cases = (await taskEvalSetFor(PROJECT, "task-a", db)).cases;
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.origin, "fix");
    assert.equal(cases[0]!.fixId, fix.id);
    assert.equal(cases[0]!.turnId, TURN);
    assert.equal(
      (
        await act({
          action: "edit-test",
          caseId: cases[0]!.id,
          expected: { tool: "lookup" },
          criteria: "Return the invoice total.",
        })
      ).ok,
      true,
    );
    cases = (await taskEvalSetFor(PROJECT, "task-a", db)).cases;
    assert.equal(cases[0]!.expected.tool, "lookup");
    assert.equal(cases[0]!.criteria, "Return the invoice total.");
    assert.equal(
      (await act({ action: "add-test", runId: TURN, expected: {}, criteria: "Updated test." })).ok,
      true,
    );
    assert.equal((await taskEvalSetFor(PROJECT, "task-a", db)).cases.length, 1);
    assert.equal((await act({ action: "run" })).ok, true);
    assert.deepEqual(runs, [
      [fix.id, { projectId: PROJECT, actor: "user_test", trigger: "manual" }],
    ]);
    assert.deepEqual(
      events.map((event) => event.what),
      ["draft", "test", "test", "test"],
    );
    assert.ok(
      events.every(
        (event) =>
          event.project_id === PROJECT &&
          event.task_id === "task-a" &&
          event.fix_id === fix.id &&
          event.actor === "user_test",
      ),
    );
    deps.ship = (input) =>
      createFixShipment(input, db, {
        // Owned (ADR-0030): the gate is the FF_EVAL_GATE env value.
        flagDeps: { FF_EVAL_GATE: "1" },
        loadFix: deps.loadFix,
      });
    assert.equal(
      (await act({ action: "mark-live", version: " v2 ", notes: " Released " })).ok,
      true,
    );
    const [shipment] = await db.select().from(fixShipments);
    assert.equal(shipment!.version, "v2");
    assert.equal(shipment!.notes, "Released");
    assert.equal(shipment!.liveMarkedBy, "user_test");
    assert.equal((await db.select().from(taskEvalRuns)).length, 2);
    assert.equal(events.at(-1)!.what, "shipment");
    const before = events.length;
    for (const command of [
      { action: "run", taskId: "unrelated-task" },
      { action: "mark-live", version: "v3", taskId: "unrelated-task" },
      { action: "draft", fixId: "missing", change },
      { action: "add-test", runId: FOREIGN, expected: {}, criteria: "" },
      { action: "edit-test", taskId: "task-b", caseId: cases[0]!.id, expected: {}, criteria: "" },
    ])
      assert.equal((await act(command)).ok, false);
    assert.equal(events.length, before);
    deps.run = async () => ({ status: "drafting" });
    assert.deepEqual(await act({ action: "run" }), {
      ok: true,
      message: "The draft is being prepared. Run again when it is ready.",
    });
  } finally {
    await client.close();
  }
});
