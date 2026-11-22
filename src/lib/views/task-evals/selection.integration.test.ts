import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { upsertScorer } from "@/lib/views/task-scorers/store";
import { selectTaskEvalRuns } from "./selection";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

// The old failures and rare intent must survive a pool dominated by recent passing runs.
test("selection mixes scorer results, open issue evidence and intents with at least twenty runs", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 40);
    await client.exec(`
      update trace_turn_steps set outcome = 'error' where turn_id = '${id(1)}';
      update trace_turns set ended_at = started_at + interval '20 seconds' where id = '${id(2)}';
      insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at)
        select id, project_id, case when id = '${id(3)}' then 'rare' else 'common' end, 'topic', started_at from trace_turns;
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        values ('${PROJECT}', 'error_loop', 'workflow', 'task-a', 1, 1, 1, '{"turnIds":["${id(4)}"]}', now(), now());
    `);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 5000 },
        updatedBy: "user_test",
      },
      db,
    );
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 0 },
        enabled: false,
        updatedBy: "user_test",
      },
      db,
    );
    const selected = await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db);
    const ids = new Set(selected.map((row) => row.turnId));
    assert.ok(selected.length >= 20);
    assert.equal(ids.size, selected.length);
    for (const n of [1, 2, 3, 4, 40]) assert.ok(ids.has(id(n)), `run ${n} is selected`);
    assert.equal(selected.find((row) => row.turnId === id(4))?.origin, "issue");
    assert.ok(selected.every((row) => row.selectionReason.length > 0));
    assert.deepEqual(
      await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db),
      selected,
    );
  } finally {
    await client.close();
  }
});

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

function id(n: number) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

async function seedRuns(client: Awaited<ReturnType<typeof setup>>["client"], count: number) {
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, '${PROJECT}', 'run-' || g, 'run-' || g,
        'declared', 'runtime', 'closed', '2026-11-01T10:00:00Z'::timestamptz + g * interval '1 minute',
        '2026-11-01T10:00:01Z'::timestamptz + g * interval '1 minute', now(), 'task-a' from generate_series(1, ${count}) g;
    insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
      select id, project_id, 1, 'invoke', 'invoke_end', gen_random_uuid(), started_at, started_at, 'tool', 'notify', 'ok' from trace_turns;
  `);
}

test("a task with fewer than twenty runs keeps every eligible run", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 9);
    await client.exec(`
      update trace_turns set status = 'open' where id = '${id(7)}';
      update trace_turns set workflow_id = 'task-b' where id = '${id(8)}';
      update trace_turns set project_id = '${OTHER}' where id = '${id(9)}';
    `);
    const selected = await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db);
    assert.deepEqual(selected.map((row) => row.turnId).sort(), [1, 2, 3, 4, 5, 6].map(id));
    assert.deepEqual(await selectTaskEvalRuns({ projectId: PROJECT, taskId: "missing" }, db), []);
  } finally {
    await client.close();
  }
});

test("selection scores only the recent two hundred runs and also keeps older issue evidence", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 225);
    await client.exec(`
      update trace_turn_steps set outcome = 'error' where turn_id in ('${id(2)}', '${id(30)}');
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        values ('${PROJECT}', 'error_loop', 'tool', 'notify', 1, 1, 1, '{"turnIds":["${id(1)}"]}', now(), now()),
          ('${PROJECT}', 'error_loop', 'workflow', 'resolved', 1, 1, 1, '{"turnIds":["${id(3)}"]}', now(), now());
      update trace_signals set status = 'resolved' where subject_key = 'resolved';
    `);
    const selected = await selectTaskEvalRuns(
      { projectId: PROJECT, taskId: "task-a", exclude: new Set([id(225)]) },
      db,
    );
    const ids = new Set(selected.map((row) => row.turnId));
    assert.ok(ids.has(id(1)));
    assert.ok(ids.has(id(30)));
    for (const n of [2, 3, 225]) assert.ok(!ids.has(id(n)));
    assert.ok(selected.length >= 20);
  } finally {
    await client.close();
  }
});

test("three open issues with eighty evidence runs stay within the target and per-issue cap", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 90);
    await client.exec(`
      insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at)
        select id, project_id, id::text, 'topic', started_at from trace_turns;
      insert into trace_signals (id, project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0'))::uuid,
          '${PROJECT}', 'error_loop', 'tool', 'issue-' || g, g, 1, 80,
          jsonb_build_object('turnIds', (select jsonb_agg(id) from trace_turns where id <= '${id(80)}')),
          now(), now() from generate_series(1, 3) g;
    `);
    const selected = await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db);
    assert.equal(selected.length, 20);
    const issues = selected.filter((row) => row.origin === "issue");
    assert.equal(issues.length, 6);
    for (const n of [1, 2, 3]) {
      const issueId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
      assert.equal(issues.filter((row) => row.selectionReason.includes(issueId)).length, 2);
    }
    assert.ok(issues[0]!.selectionReason.includes("bbbbbbbb-bbbb-4bbb-8bbb-000000000003"));
    assert.equal(new Set(selected.map((row) => row.turnId)).size, 20);
  } finally {
    await client.close();
  }
});

test("four scorers retain passing and failing examples with explicit reasons and intent coverage", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 60);
    await client.exec(`
      update trace_turn_steps set outcome = 'error' where turn_id in ('${id(1)}', '${id(2)}');
      insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
        select id, project_id, 2, 'invoke', 'invoke_end', gen_random_uuid(), started_at, started_at, 'tool', 'notify', 'ok'
        from trace_turns where id = '${id(2)}';
      update trace_turns set ended_at = started_at + interval '20 seconds' where id = '${id(3)}';
      insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at)
        select id, project_id, case when id = '${id(4)}' then 'rare' else 'common' end, 'topic', started_at from trace_turns;
    `);
    await client.exec(`
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        select '${PROJECT}', 'error_loop', 'tool', 'issue-' || g, g, 1, 60,
          jsonb_build_object('turnIds', (select jsonb_agg(id) from trace_turns)), now(), now()
          from generate_series(1, 3) g;
    `);
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_latency_ms", max: 5000 },
        updatedBy: "user_test",
      },
      db,
    );
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "task-a",
        scorer: { kind: "max_tool_calls", max: 1 },
        updatedBy: "user_test",
      },
      db,
    );
    const selected = await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db);
    assert.equal(selected.length, 20);
    for (const kind of ["ends_well", "max_self_corrections", "max_latency_ms", "max_tool_calls"]) {
      for (const status of ["pass", "fail"]) {
        assert.ok(
          selected.some((row) => row.selectionReason.includes(`${kind}: ${status}`)),
          `${kind} has a ${status} example`,
        );
      }
    }
    assert.ok(
      selected.some((row) => row.turnId === id(4)),
      "the rare intent remains represented",
    );
    assert.ok(
      selected
        .filter((row) => row.origin === "auto")
        .every((row) => /: (pass|fail|skip)/.test(row.selectionReason)),
      "every automatic case names its scorer result",
    );
  } finally {
    await client.close();
  }
});

test("issue evidence uses at most seven slots and prioritizes eligible open issues by severity", async () => {
  const { client, db } = await setup();
  try {
    await seedRuns(client, 90);
    await client.exec(`
      insert into trace_signals (id, project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0'))::uuid,
          '${PROJECT}', 'error_loop', 'tool', 'issue-' || g, g, 1, 2,
          jsonb_build_object('turnIds', jsonb_build_array(
            'aaaaaaaa-aaaa-4aaa-8aaa-' || lpad((2*g-1)::text, 12, '0'),
            'aaaaaaaa-aaaa-4aaa-8aaa-' || lpad((2*g)::text, 12, '0'))), now(), now()
          from generate_series(1, 8) g;
      update trace_turns set workflow_id = 'task-b' where id in ('${id(15)}', '${id(16)}');
      update trace_turns set project_id = '${OTHER}' where id in ('${id(13)}', '${id(14)}');
      update trace_signals set status = 'resolved' where subject_key = 'issue-6';
      update trace_turns set status = 'open' where id = '${id(10)}';
      insert into trace_signals (project_id, kind, subject_kind, subject_key, severity, impact, n, evidence, first_seen_at, last_seen_at)
        values ('${OTHER}', 'error_loop', 'workflow', 'task-a', 100, 1, 2,
          '{"turnIds":["${id(1)}","${id(2)}"]}', now(), now());
    `);
    const selected = await selectTaskEvalRuns({ projectId: PROJECT, taskId: "task-a" }, db);
    const issues = selected.filter((row) => row.origin === "issue");
    assert.equal(selected.length, 20);
    assert.equal(issues.length, 7);
    assert.deepEqual(
      issues.map((row) => row.turnId),
      [9, 8, 7, 6, 5, 4, 3].map(id),
    );
    for (const n of [1, 6, 7, 8]) {
      assert.ok(
        issues.every(
          (row) =>
            !row.selectionReason.includes(`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`),
        ),
      );
    }
  } finally {
    await client.close();
  }
});
