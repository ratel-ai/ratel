import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { taskEvalViewFor } from "./store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ISSUE = "cccccccc-cccc-4ccc-8ccc-000000000001";

test("the eval view loads captured asks, enabled scorer results, issue titles and refresh progress within the project", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('22222222-2222-4222-8222-222222222222', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values
        ('${PROJECT}', '22222222-2222-4222-8222-222222222222', 'Agent', 'agent'),
        ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
      insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
        select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, '${PROJECT}', 'run-' || g, 'run-' || g,
          'declared', 'runtime', 'closed', '2026-11-01T12:00:00Z', '2026-11-01T12:00:02Z', now(), 'task-a' from generate_series(1, 2) g;
      insert into trace_events (id, project_id, type, occurred_at, received_at, client_event_id, trace_id, payload)
        select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0'))::uuid, '${PROJECT}', 'invoke_end',
          '2026-11-01T12:00:01Z', now(), 'event-' || g, 'trace-' || g, '{}' from generate_series(1, 2) g;
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
        select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, '${PROJECT}', 1, 'invoke', 'invoke_end',
          ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0'))::uuid, '2026-11-01T12:00:01Z', now(), 'tool', 'track_delivery', 'ok' from generate_series(1, 2) g;
      insert into events (project_id, trace_id, occurred_at, received_at, finish_reason, cost_usd, payload)
        select '${PROJECT}', 'trace-' || g, '2026-11-01T12:00:02Z', now(), 'stop', 0.01,
          '{"messages":[{"role":"user","content":"Track the steel delivery."},{"role":"user","content":"Any updates?"}]}' from generate_series(1, 2) g;
      insert into task_eval_sets (project_id, task_id, target_runs, scorer_version) values ('${PROJECT}', 'task-a', 20, 1);
      insert into task_eval_cases (project_id, task_id, turn_id, origin, selection_reason) values
        ('${PROJECT}', 'task-a', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'auto', 'max_latency_ms: fail'),
        ('${PROJECT}', 'task-a', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'issue', 'Evidence of issue ${ISSUE}.');
      insert into trace_signals (id, project_id, kind, subject_kind, subject_key, severity, impact, n, first_seen_at, last_seen_at)
        values ('${ISSUE}', '${PROJECT}', 'error_loop', 'workflow', 'task-a', 1, 1, 1, now(), now());
      insert into task_scorers (project_id, task_id, kind, config, enabled, source, updated_by) values
        ('${PROJECT}', 'task-a', 'max_latency_ms', '{"max":1000}', true, 'user', 'user_test'),
        ('${PROJECT}', 'task-a', 'max_cost_usd', '{"max":0.001}', false, 'user', 'user_test');
      insert into jobs (project_id, kind, status, payload) values ('${PROJECT}', 'refresh_task_eval_set', 'running', '{"taskId":"task-a"}');
    `);
    const view = await taskEvalViewFor(PROJECT, "task-a", db);
    assert.equal(view.rows.length, 2);
    assert.equal(view.rows[0]!.ask, "Track the steel delivery.");
    assert.equal(view.rows[0]!.selectionReason, "Fails Run time");
    assert.equal(view.rows[0]!.chips.find((chip) => chip.kind === "ends_well")?.status, "pass");
    assert.equal(
      view.rows[0]!.chips.some((chip) => chip.kind === "max_cost_usd"),
      false,
    );
    assert.match(view.rows[1]!.selectionReason, /^Evidence of: /);
    assert.equal(view.rows[1]!.issueHref, `/project/${PROJECT}/health?peek=issue%3A${ISSUE}`);
    assert.equal(view.refreshJob?.status, "running");
    await client.exec(`update jobs set status = 'done' where project_id = '${PROJECT}'`);
    assert.equal((await taskEvalViewFor(PROJECT, "task-a", db)).refreshJob?.status, "done");
    const foreign = await taskEvalViewFor(OTHER, "task-a", db);
    assert.deepEqual(foreign.rows, []);
    assert.equal(foreign.refreshJob, null);
  } finally {
    await client.close();
  }
});
