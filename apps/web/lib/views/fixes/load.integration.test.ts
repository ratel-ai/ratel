import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { loadFixes } from "./load";
import { fixSeams } from "./seams";
import { findFix } from "./select";

/**
 * Owned (ADR-0030): upstream also seeds the tool crafter's drafts and quality's rewrites; here
 * those sources arrive through `fixSeams`, which the tests leave empty and fill with a stub.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  await upsertRuntimeCatalogEntries(
    ["lookup_order", "find_task", "assign_task", "notify"].map((id) => ({
      projectId: PROJECT,
      kind: "tool" as const,
      entryId: id,
      name: id,
      description: `${id} does its job.`,
      searchableDescription: `${id} does its job.`,
      searchableDescriptionOverridden: false,
      tags: [],
      inputSchema: null,
      outputSchema: null,
      contentHash: `h-${id}`,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })),
    "events",
    db,
  );
  return { client, db };
}

async function seedSources(client: PGlite): Promise<void> {
  const summary = {
    version: 1,
    coveredFrom: "2026-10-01",
    daily: [{ day: "2026-10-19", turns: 50 }],
    flow: { nodes: [], edges: [] },
    workflows: {
      version: 1,
      turnsWithTools: 60,
      multiToolTurns: 50,
      singleStepTurns: 10,
      assignedTurns: 40,
      truncated: false,
      items: [
        {
          id: "wf_assign",
          fingerprint: "wf_assign",
          coreTools: ["find_task", "assign_task"],
          optionalTools: [],
          helperTools: [],
          entryTool: "find_task",
          typicalOrder: ["find_task", "assign_task"],
          orderStability: 0.9,
          runs: 40,
          share: 0.8,
        },
      ],
    },
  };
  await client.query(
    `insert into trace_signal_runs (id, project_id, trigger, status, window_days, window_start, window_end, summary, finished_at, created_at)
     values ('33333333-3333-4333-8333-333333333333', $1, 'manual', 'completed', 30, $2, $3, $4::jsonb, $3, $3)`,
    [PROJECT, ago(30), NOW.toISOString(), JSON.stringify(summary)],
  );
  await client.query(
    `insert into trace_workflow_labels (project_id, workflow_id, input_hash, name, description) values ($1, 'wf_assign', 'h', 'Hand a task over', '')`,
    [PROJECT],
  );
  // An open issue about lookup_order, and one resolved that must not count.
  await client.query(
    `insert into trace_signals (id, project_id, kind, subject_kind, subject_key, subject, status, severity, impact, n, metrics, evidence, first_seen_at, last_seen_at)
     values
       ('44444444-4444-4444-8444-444444444441', $1, 'magnet', 'tool', 'lookup_order', '{"ids":["lookup_order"],"entryKind":"tool"}', 'open', 0.4, 30, 300,
        '{"route":"rewrite_description","impressions":300,"searches":700,"picks":3,"listShare":0.43,"pickShare":0.01}', '{"totalTurns":120}', $2, $3),
       ('44444444-4444-4444-8444-444444444442', $1, 'magnet', 'tool', 'notify', '{"ids":["notify"],"entryKind":"tool"}', 'resolved', 0.4, 30, 300,
        '{"route":"rewrite_description"}', '{}', $2, $3)`,
    [PROJECT, ago(10), ago(1)],
  );
  // One topic whose turns run lookup_order.
  await client.query(
    `insert into trace_topics (project_id, topic_id, name, input_hash) values ($1, 'topic_orders', 'Order status', 'h'), ($1, 'topic_gone', 'Old', 'h')`,
    [PROJECT],
  );
  await client.query(
    `update trace_topics set retired_at = $2 where project_id = $1 and topic_id = 'topic_gone'`,
    [PROJECT, ago(2)],
  );
  await client.query(
    `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at)
     values ('99999999-9999-4999-8999-999999999991', $1, 's1', 'k1', 'declared', 'runtime', 'closed', $2, $2, $2)`,
    [PROJECT, ago(3)],
  );
  await client.query(
    `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
     values ('99999999-9999-4999-8999-999999999991', $1, 1, 'invoke', 'invoke_start', gen_random_uuid(), $2, $2, 'tool', 'lookup_order', 'ok')`,
    [PROJECT, ago(3)],
  );
  await client.query(
    `insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at) values ('99999999-9999-4999-8999-999999999991', $1, 'topic_orders', 'topic', $2)`,
    [PROJECT, ago(3)],
  );
}

async function organization(db: Db) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, ORG));
  assert.ok(org);
  return org;
}

test("the issue and topic sources read into one list, linked by subject; a seam adds nothing while it has nothing to read", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  const model = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });

  assert.deepEqual(model.failed, []);
  assert.equal(model.rewritesOn, true, "quality fills its seam; with no run there are no rewrites");
  assert.deepEqual(
    model.open.map((fix) => fix.id),
    ["issue:44444444-4444-4444-8444-444444444441"],
  );

  const fix = model.open[0]!;
  assert.equal(fix.source, "issue");
  assert.equal(fix.kind, "rewrite");
  assert.equal(fix.title, "Rewrite lookup_order's searchable description");
  assert.deepEqual(
    fix.issues.map((issue) => issue.id),
    ["44444444-4444-4444-8444-444444444441"],
  );
  assert.deepEqual(
    fix.subject.topics.map((topic) => [topic.id, topic.label]),
    [["topic_orders", "Order status"]],
  );
  assert.equal(fix.actions.apply, false);
  await client.close();
});

test("a filled draft seam contributes its fixes, and a failing one is named", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  const before = { ...fixSeams };
  try {
    fixSeams.loadDrafts = async (_projectId, _db, context) => [
      {
        id: "66666666-6666-4666-8666-666666666661",
        kind: "merge_tools",
        key: "merge_tools:assign_task,find_task",
        createdAt: ago(1),
        toolIds: ["find_task", "assign_task"],
        taskIds: [],
        intentId: null,
        ask: null,
        why: `Always together (${context.names.size} tools named).`,
        effect: null,
        gain: { roundTrips: 40, calls: 40, ms: 0 },
        evidence: { strength: "strong", label: "Strong", detail: "Seen 40 times in this window" },
        copy: { label: "Copy prompt", text: "## Problem" },
        detail: {
          source: "craft",
          craftKind: "merge_tools",
          plain: "",
          why: ["Always together."],
          worth: [],
          worthCaption: null,
          replay: null,
          change: [],
          facts: [],
          sources: [],
          crafted: [],
        },
        measured: true,
        score: 40,
      },
    ];
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(model.failed, []);
    const merge = findFix(model.open, "craft:66666666-6666-4666-8666-666666666661");
    assert.equal(merge?.title, "Merge find_task and assign_task");
    assert.deepEqual(
      merge?.subject.tasks.map((task) => [task.id, task.label, task.color]),
      [["wf_assign", "Hand a task over", "chart-1"]],
    );

    fixSeams.loadDrafts = async () => {
      throw new Error("the crafter's table is gone");
    };
    const partial = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(partial.failed, ["craft"]);
    assert.ok(
      findFix(partial.open, "issue:44444444-4444-4444-8444-444444444441"),
      "the other sources still list",
    );
  } finally {
    fixSeams.loadDrafts = before.loadDrafts;
  }
  await client.close();
});

test("a source that cannot be read costs its fixes, never the list", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  await client.exec("drop table trace_signals cascade");
  const model = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.deepEqual(model.failed, ["issue"]);
  assert.deepEqual(model.open, []);
  await client.close();
});

/** One intent whose 60 turns run find_task then notify, as the topics job stores it, and no skill near it. */
async function seedIntentReading(client: PGlite): Promise<void> {
  const pattern = {
    withCalls: 60,
    tools: [
      { id: "find_task", turns: 50 },
      { id: "notify", turns: 45 },
    ],
    runs: 42,
    inOrder: 40,
    also: [],
    helpers: [],
    firsts: [{ id: "find_task", turns: 48 }],
    comesBefore: [],
    skills: { invoked: 0, offered: 0 },
  };
  await client.query(
    `insert into trace_topics (project_id, topic_id, name, input_hash) values ($1, 'topic_tasks', 'Hand work over', 'h')`,
    [PROJECT],
  );
  await client.query(`insert into trace_topic_insights (project_id, data) values ($1, $2::jsonb)`, [
    PROJECT,
    JSON.stringify({
      version: 1,
      topics: [
        { id: "topic_tasks", turns: 60, tasks: [], pattern },
        { id: "topic_gone", turns: 80, tasks: [], pattern },
      ],
    }),
  ]);
}

test("an intent no skill covers is read into a skill fix, on every page; a published skill naming its steps clears it", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  await seedIntentReading(client);
  const model = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.deepEqual(model.failed, []);
  const gap = findFix(model.open, "intent:topic_tasks");
  assert.equal(gap?.title, "Add a skill for Hand work over");
  assert.equal(gap?.group, "skills");
  assert.deepEqual(gap?.intent, {
    id: "topic_tasks",
    label: "Hand work over",
    href: `/project/${PROJECT}/intents?peek=topic_tasks`,
  });
  assert.equal(findFix(model.open, "intent:topic_gone"), null, "a retired intent raises nothing");
  const overview = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    topics: false,
    deps: { db },
  });
  assert.equal(
    findFix(overview.open, "intent:topic_tasks")?.title,
    "Add a skill for Hand work over",
    "the same title without the topic read",
  );

  await client.query(
    `insert into skills (project_id, name, status, tools) values ($1, 'hand-over', 'published', '["find_task","notify"]'::jsonb)`,
    [PROJECT],
  );
  const after = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.equal(findFix(after.open, "intent:topic_tasks"), null);
  await client.close();
});

test("a skill gap read that fails is named, and the rest still lists", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  await seedIntentReading(client);
  await client.exec("drop table trace_topic_insights cascade");
  const model = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.deepEqual(model.failed, ["intent"]);
  assert.ok(findFix(model.open, "issue:44444444-4444-4444-8444-444444444441"));
  await client.close();
});
