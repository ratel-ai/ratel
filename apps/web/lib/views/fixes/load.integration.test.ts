import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { dismissCraftProposal } from "@/lib/synthesis/tool-crafter/queries";
import { loadFixes } from "./load";
import { fixSeams } from "./seams";
import { findFix } from "./select";

/**
 * Owned (ADR-0030): the tool crafter's drafts and quality's rewrites arrive through `fixSeams`,
 * filled by `craft-drafts.ts` and `quality/fix-rewrites.ts` when `load.ts` loads. The crafter's
 * rows are seeded as upstream seeds them; the rewrite cases live with quality.
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

/** Drafted changes: one pending merge, one superseded that must not show. */
async function seedDrafts(client: PGlite): Promise<void> {
  await client.query(
    `insert into tool_explorer_runs (id, project_id, trigger, status, window_days, window_start, window_end)
     values ('99999999-9999-4999-8999-999999999999', $1, 'manual', 'completed', 30, $2, $3)`,
    [PROJECT, ago(30), NOW.toISOString()],
  );
  await client.query(
    `insert into tool_craft_runs (id, project_id, trigger, status, created_at, explorer_run_id) values ('55555555-5555-4555-8555-555555555555', $1, 'chained', 'crafted', $2, '99999999-9999-4999-8999-999999999999')`,
    [PROJECT, ago(1)],
  );
  const merge = {
    kind: "merge_tools",
    merge: {
      scope: "turn",
      support: 40,
      unitsA: 42,
      unitsB: 41,
      jaccard: 0.93,
      jaccardLow: 0.88,
      pAb: 0.95,
      pBa: 0.97,
      nextP: 0.9,
      orderAb: 38,
      orderBa: 2,
      exampleSessions: [],
    },
  };
  for (const [id, status] of [
    ["66666666-6666-4666-8666-666666666661", "pending"],
    ["66666666-6666-4666-8666-666666666662", "superseded"],
  ] as const) {
    await client.query(
      `insert into tool_craft_proposals (id, run_id, project_id, kind, status, source_tool_ids, source_definitions, crafted, rationale, evidence, created_at)
       values ($1, '55555555-5555-4555-8555-555555555555', $2, 'merge_tools', $3, '{find_task,assign_task}', $4::jsonb, '[]'::jsonb, 'Always together.', $5::jsonb, $6)`,
      [
        id,
        PROJECT,
        status,
        JSON.stringify(
          ["find_task", "assign_task"].map((tool) => ({
            id: tool,
            name: tool,
            description: "",
            searchableDescription: null,
            inputSchema: null,
          })),
        ),
        JSON.stringify(merge),
        ago(1),
      ],
    );
  }
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

test("the crafter's pending draft is a fix with its gain, window and evidence; dismissed, it is gone; a failing read is named", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  await seedDrafts(client);
  assert.equal(
    typeof fixSeams.loadDrafts,
    "function",
    "craft-drafts.ts filled the seam when load.ts loaded",
  );
  const model = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.deepEqual(model.failed, []);
  assert.deepEqual(
    model.open.filter((fix) => fix.source === "craft").map((fix) => fix.id),
    ["craft:66666666-6666-4666-8666-666666666661"],
    "the superseded draft does not show",
  );
  const merge = findFix(model.open, "craft:66666666-6666-4666-8666-666666666661");
  assert.equal(merge?.title, "Merge find_task and assign_task");
  // The run's day buckets carry no linked model calls, so the price is none: the calls are
  // counted over the crafter run's 30 days, and no token, cost or waiting saving is claimed.
  assert.equal(merge?.effect, null);
  assert.deepEqual(merge?.evidence, {
    strength: "strong",
    label: "Strong",
    detail: "Seen 40 times in this window",
  });
  assert.deepEqual(merge?.gain, {
    windowDays: 30,
    roundTrips: 40,
    calls: 40,
    tokens: null,
    usd: null,
    ms: null,
  });
  assert.deepEqual(
    merge?.subject.tasks.map((task) => [task.id, task.label, task.color]),
    [["wf_assign", "Hand a task over", "chart-1"]],
  );
  assert.equal(merge?.actions.dismiss, true);
  assert.equal(merge?.actions.apply, false);

  // Dismissed (what the Fixes action does through the seam), it is gone from the next read.
  assert.equal(
    await dismissCraftProposal(PROJECT, "66666666-6666-4666-8666-666666666661", NOW, db),
    true,
  );
  const after = await loadFixes({
    projectId: PROJECT,
    organization: await organization(db),
    now: NOW,
    deps: { db },
  });
  assert.deepEqual(after.failed, []);
  assert.equal(findFix(after.open, "craft:66666666-6666-4666-8666-666666666661"), null);

  await client.exec("drop table tool_craft_proposals cascade");
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

/** Upstream's savings cases (#323), on the crafter's seeded merge of the hand-over task's tools. */
async function savingsSetup(): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setup();
  await seedSources(client);
  await seedDrafts(client);
  return { client, db };
}

const STORED_COST = {
  version: 1,
  runs: 40,
  steps: [],
  cost: { linkedRuns: 40, pricedRuns: 40, totalUsd: 4, medianUsd: 0.1, medianModelCalls: 2 },
};
const LINKED_COST = [
  { day: "2026-10-19", linked: { runs: 2, modelCalls: 4, pricedRuns: 2, costUsd: 0.04 } },
];

test("task savings use measured usage from linked runs in the signal window", async () => {
  const { client, db } = await savingsSetup();
  try {
    await client.query(
      `update trace_signal_runs set summary = jsonb_set(summary, '{daily}', $2::jsonb) where project_id = $1`,
      [
        PROJECT,
        JSON.stringify([
          {
            day: "2026-10-19",
            turns: 50,
            linked: {
              runs: 2,
              modelCalls: 4,
              pricedRuns: 2,
              costUsd: 0.04,
              modelMs: 400,
              inputTokens: 4_000,
              outputTokens: 1_000,
            },
          },
        ]),
      ],
    );
    for (const [session, at] of [
      ["usage-1", ago(2)],
      ["usage-2", ago(3)],
      ["before-window", ago(31)],
      ["after-window", ago(-1)],
    ] as const) {
      const end = new Date(new Date(at).getTime() + 5_000).toISOString();
      await client.query(
        `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, workflow_id, started_at, ended_at, last_received_at)
         values ($1, $2, $2, 'declared', 'runtime', 'closed', 'wf_assign', $3, $4, $4)`,
        [PROJECT, session, at, end],
      );
      await client.query(
        `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, ingest_source, client_event_id, took_ms, input_tokens, output_tokens, payload)
         values (gen_random_uuid(), $1, 'otlp_model_call', $2, $3, $3, 'otlp', $2, 100, 2000, 500, '{"model":"claude-sonnet-4-6"}'::jsonb)`,
        [PROJECT, session, at],
      );
    }
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(model.failed, []);
    const entry = model.stats.savings.tasks.find((candidate) => candidate.task.id === "wf_assign");
    assert.ok(entry);
    assert.deepEqual(entry.absolute, { tokens: 50_000 / 30, usd: 0.4 / 30, ms: 4_000 / 30 });
    assert.ok(Math.abs((entry.relative.tokens ?? 0) - 10) < 1e-9);
    assert.ok(Math.abs((entry.relative.ms ?? 0) - 0.4) < 1e-9);
    assert.ok(
      entry.relative.usd !== null && Math.abs(entry.relative.usd - 14.814814814814815) < 1e-9,
    );
    // The draft's own effect is the same saving, told for a month.
    const merge = findFix(model.open, "craft:66666666-6666-4666-8666-666666666661");
    assert.equal(merge?.effect?.value, "−50k tokens · −$0.40 · −4 s waiting per month");
  } finally {
    await client.close();
  }
});

test("a task with untimed and unpriced model calls has no token or cost share", async () => {
  const { client, db } = await savingsSetup();
  try {
    await client.query(
      `update trace_turns set workflow_id = 'wf_assign', ended_at = started_at + interval '1 second' where project_id = $1`,
      [PROJECT],
    );
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, ingest_source, client_event_id, payload)
       values (gen_random_uuid(), $1, 'otlp_model_call', 's1', $2, $2, 'otlp', 'unknown-usage', '{}'::jsonb)`,
      [PROJECT, ago(3)],
    );
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(model.stats.savings.tasks[0]?.relative, { tokens: null, usd: null, ms: null });
    assert.deepEqual(model.stats.savings.tasks[0]?.absolute, { tokens: null, usd: null, ms: null });
  } finally {
    await client.close();
  }
});

test("task cost shares use the stored task reading when source events are absent", async () => {
  const { client, db } = await savingsSetup();
  try {
    await client.query(
      `update trace_signal_runs set summary = jsonb_set(jsonb_set(summary, '{daily}', $2::jsonb), '{workflows,items,0,reading}', $3::jsonb) where project_id = $1`,
      [PROJECT, JSON.stringify(LINKED_COST), JSON.stringify(STORED_COST)],
    );
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(model.stats.savings.tasks[0]?.relative, { tokens: null, usd: 0.1, ms: null });
  } finally {
    await client.close();
  }
});

test("draft savings retain their source window when task usage covers another window", async () => {
  const { client, db } = await savingsSetup();
  try {
    await client.query(
      `update tool_explorer_runs set window_days = 7, window_start = $2 where project_id = $1`,
      [PROJECT, ago(7)],
    );
    await client.query(
      `update trace_signal_runs set summary = jsonb_set(jsonb_set(summary, '{daily}', $2::jsonb), '{workflows,items,0,reading}', $3::jsonb) where project_id = $1`,
      [PROJECT, JSON.stringify(LINKED_COST), JSON.stringify(STORED_COST)],
    );
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.equal(model.open.find((fix) => fix.source === "craft")?.gain?.windowDays, 7);
    assert.ok(
      Math.abs((model.stats.savings.tasks[0]?.relative.usd ?? 0) - 0.42857142857142855) < 1e-9,
    );
  } finally {
    await client.close();
  }
});

test("a draft window read that fails leaves the drafts listed, without a rate", async () => {
  const { client, db } = await savingsSetup();
  const loadDraftWindows = fixSeams.loadDraftWindows;
  fixSeams.loadDraftWindows = async () => {
    throw new Error("the windows could not be read");
  };
  try {
    const model = await loadFixes({
      projectId: PROJECT,
      organization: await organization(db),
      now: NOW,
      deps: { db },
    });
    assert.deepEqual(model.failed, [], "the drafts were read: no source failed");
    const merge = findFix(model.open, "craft:66666666-6666-4666-8666-666666666661");
    assert.equal(merge?.gain?.windowDays, null);
    assert.equal(merge?.gain?.roundTrips, 40);
  } finally {
    fixSeams.loadDraftWindows = loadDraftWindows;
    await client.close();
  }
});

/** Quality's rewrites, as upstream seeds them: one pending for lookup_order, one dismissed. */
async function seedRewrites(client: PGlite): Promise<void> {
  await client.query(
    `insert into match_quality_runs (id, project_id, experiment_name, trigger, status, window_days, window_start, window_end, created_at)
     values ('77777777-7777-4777-8777-777777777777', $1, 'ratel:search-telemetry', 'manual', 'analyzed', 7, $2, $3, $3)`,
    [PROJECT, ago(7), ago(1)],
  );
  const evidence = {
    misses: 9,
    failures: [
      {
        query: "where is my order",
        ourRank: null,
        ourTop: "find_task",
        baselineTop: null,
        targetSource: "invoked",
      },
    ],
  };
  await client.query(
    `insert into match_quality_proposals (id, run_id, project_id, entry_id, entry_name, status, current_searchable, current_source, proposed_searchable, rationale, evidence, preview, created_at, updated_at)
     values
       ('88888888-8888-4888-8888-888888888881', '77777777-7777-4777-8777-777777777777', $1, 'lookup_order', 'lookup_order', 'pending',
        'Look up an order.', 'runtime', 'Look up an order. Use for order status.', 'Added the words.', $2::jsonb, '{}'::jsonb, $3, $3),
       ('88888888-8888-4888-8888-888888888882', '77777777-7777-4777-8777-777777777777', $1, 'notify', 'notify', 'dismissed',
        'Notify.', 'runtime', 'Notify someone.', 'Added the words.', '{}'::jsonb, '{}'::jsonb, $3, $3)`,
    [PROJECT, JSON.stringify(evidence), ago(1)],
  );
}

test("the override adoption is a read of its own: failing, the rewrites are still listed", async () => {
  const { client, db } = await setup();
  await seedSources(client);
  await seedRewrites(client);
  const load = async () =>
    loadFixes({ projectId: PROJECT, organization: await organization(db), now: NOW, deps: { db } });
  const rewrite = "rewrite:88888888-8888-4888-8888-888888888881";
  const loadOverrideAdoption = fixSeams.loadOverrideAdoption;
  assert.equal(typeof loadOverrideAdoption, "function", "quality filled the seam");
  try {
    // Nothing fetched the overrides yet: unknown, and the rewrite says it may not reach the agent.
    const unknown = await load();
    assert.equal(unknown.overridesAdopted, null);
    assert.ok(findFix(unknown.open, rewrite));

    await client.query(`update projects set overrides_pulled_at = $2 where id = $1`, [
      PROJECT,
      ago(0),
    ]);
    assert.equal((await load()).overridesAdopted, true);

    fixSeams.loadOverrideAdoption = async () => {
      throw new Error("the adoption could not be read");
    };
    const partial = await load();
    assert.deepEqual(partial.failed, [], "the rewrites were read: no source failed");
    assert.equal(partial.rewritesOn, true);
    assert.equal(partial.overridesAdopted, null, "unknown, as when nothing fetched them");
    assert.equal(
      findFix(partial.open, rewrite)?.title,
      "Rewrite lookup_order's searchable description",
    );
  } finally {
    fixSeams.loadOverrideAdoption = loadOverrideAdoption;
    await client.close();
  }
});
