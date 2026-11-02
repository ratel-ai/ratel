import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import * as schema from "@/lib/platform/db/tables";
import { organizations } from "@/lib/platform/identity/schema";
import { computeToolExplorer } from "@/lib/readings/tool-explorer/compute";
import { exploreProjectToolUsage } from "@/lib/readings/tool-explorer/job";
import {
  failExplorerRun,
  latestExplorerRun,
  listCousage,
  listMergeCandidates,
  listTransitions,
  persistExplorerRun,
  reapStaleExplorerRuns,
  startExplorerRun,
} from "@/lib/readings/tool-explorer/queries";
import type { ExplorerNode } from "@/lib/readings/tool-explorer/types";
import {
  count,
  type Db,
  PROJECT_ID,
  seedLedger,
  setupDb,
  type Tracked,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import {
  type CraftJobDeps,
  craftProjectTools,
  loadIntentPatternsForCraft,
} from "@/lib/synthesis/tool-crafter/job";
import {
  dismissCraftProposal,
  enqueueCraftJob,
  failCraftRun,
  finishCraftRun,
  getCraftProposal,
  latestCraftRun,
  listCraftProposals,
  reapStaleCraftRuns,
  startCraftRun,
} from "@/lib/synthesis/tool-crafter/queries";
import { toolCraftProposals } from "@/lib/synthesis/tool-crafter/schema";
import type { CraftedToolDefinition, JsonSchemaObject } from "@/lib/synthesis/tool-crafter/types";

const NOW = new Date("2026-09-02T00:00:00Z");
const ORG = "22222222-2222-4222-8222-222222222222";

/** 40 turns that find a task and assign it, and 130 that only search tasks. */
function fixtures() {
  return [
    ...times(130, () => fresh().search(["create_task", "search_tasks"]).invoke("search_tasks")),
    ...times(40, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ];
}

const entry = (
  id: string,
  description: string,
  searchable: string,
  inputSchema: JsonSchemaObject,
) => ({
  projectId: PROJECT_ID,
  kind: "tool" as const,
  entryId: id,
  name: id,
  description,
  searchableDescription: searchable,
  searchableDescriptionOverridden: false,
  tags: [],
  inputSchema,
  outputSchema: null,
  contentHash: `h-${id}`,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
});

async function seedCatalog(db: Db): Promise<void> {
  await upsertRuntimeCatalogEntries(
    [
      entry("find_task", "Find a task by its title or key.", "find task title key", {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      }),
      entry("assign_task", "Assign a task to a teammate.", "assign task teammate", {
        type: "object",
        properties: { taskId: { type: "string" }, assignee: { type: "string" } },
        required: ["taskId", "assignee"],
      }),
      entry("search_tasks", "Search tasks.", "search tasks", { type: "object", properties: {} }),
      entry("create_task", "Create a task.", "create task", { type: "object", properties: {} }),
    ],
    "snapshot",
    db,
  );
}

async function runExplorer(db: Db): Promise<void> {
  const org = async () =>
    (await db.select().from(organizations).where(eq(organizations.id, ORG)))[0] ?? null;
  const result = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    {
      getOrganizationByProjectId: org,
      reapStale: (p, before, _db, at) => reapStaleExplorerRuns(p, before, db, at),
      startRun: (input, _db, at) => startExplorerRun(input, db, at),
      failRun: (id, error, _db, at) => failExplorerRun(id, error, db, at),
      persist: (input) => persistExplorerRun(input, db),
      compute: (projectId, window, options) =>
        computeToolExplorer(projectId, window, {
          ...options,
          listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
          loadWorkflows: async () => [],
          intentsForTurns: async () => new Map(),
          loadIntentTexts: async () => new Map(),
          loadErrorMessages: async () => new Map(),
          analysis: { cousage: { minSupport: 5, minShare: 0 } },
        }),
      observability: { trackSystemEvent: async () => {} },
      now: () => NOW,
    },
  );
  assert.equal(result.outcome, "completed");
}

function craftDeps(
  db: Db,
  tracked: Tracked[] = [],
  over: Partial<CraftJobDeps> = {},
): Partial<CraftJobDeps> {
  return {
    getOrganizationByProjectId: async () =>
      (await db.select().from(organizations).where(eq(organizations.id, ORG)))[0] ?? null,
    reapStale: (p, before, _db, at) => reapStaleCraftRuns(p, before, db, at),
    startRun: (input, _db, at) => startCraftRun(input, db, at),
    failRun: (id, error, _db, at) => failCraftRun(id, error, db, at),
    finishRun: (input) => finishCraftRun(input, db),
    reads: {
      loadExplorer: async (p) => {
        const run = await latestExplorerRun(p, db, "completed");
        const [sets, pairs, next, before] = await Promise.all([
          listMergeCandidates(p, { scope: "turn" }, db),
          listCousage(p, { scope: "turn", size: 2 }, db),
          listTransitions(p, { scope: "turn", kind: "next" }, db),
          listTransitions(p, { scope: "turn", kind: "before" }, db),
        ]);
        const summary = (run?.summary ?? null) as { nodes?: ExplorerNode[] } | null;
        return {
          runId: run?.id ?? null,
          windowDays: run?.windowDays ?? 0,
          sets,
          pairs,
          edges: [...next, ...before],
          nodes: summary?.nodes ?? [],
        };
      },
      loadSources: async (p) => {
        const rows = await db
          .select()
          .from(runtimeCatalogEntries)
          .where(eq(runtimeCatalogEntries.projectId, p));
        return rows.map((r) => ({
          id: r.entryId,
          name: r.name,
          description: r.description,
          searchableDescription: r.searchableDescriptionOverride ?? r.searchableDescription,
          inputSchema: r.inputSchema as JsonSchemaObject | null,
        }));
      },
      loadDeficits: async () => [],
    },
    observability: {
      trackSystemEvent: async (event, _id, properties) => {
        tracked.push({ event, properties });
      },
    },
    now: () => NOW,
    ...over,
  };
}

test("a craft run reads the explorer's always-together pair and stores a rule-drafted merge", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await seedCatalog(db);
  await runExplorer(db);
  assert.equal((await listMergeCandidates(PROJECT_ID, { scope: "turn" }, db)).length, 1);

  assert.ok(await enqueueCraftJob(PROJECT_ID, db));
  assert.equal(await enqueueCraftJob(PROJECT_ID, db), null, "coalesced");

  const tracked: Tracked[] = [];
  const result = await craftProjectTools(PROJECT_ID, craftDeps(db, tracked));
  assert.equal(result.outcome, "crafted");
  assert.equal(
    result.proposals,
    2,
    "the merge, and the never-called create_task retired in favour of search_tasks",
  );
  const run = await latestCraftRun(PROJECT_ID, db);
  assert.equal(run?.status, "crafted");
  assert.equal(
    run?.explorerRunId,
    (await latestExplorerRun(PROJECT_ID, db, "completed"))?.id,
    "the run names the explorer reading it read",
  );
  assert.deepEqual(
    (run?.candidates as { kind: string; outcome: string }[]).map((c) => [c.kind, c.outcome]),
    [
      ["merge_tools", "proposed"],
      ["deprecate_tool", "proposed"],
    ],
  );

  const pending = await listCraftProposals(PROJECT_ID, { statuses: ["pending"] }, db);
  const retire = pending.find((p) => p.kind === "deprecate_tool");
  assert.deepEqual(
    [retire?.sourceToolIds, retire?.hiddenToolIds, retire?.crafted],
    [["create_task"], ["create_task"], []],
  );
  assert.match(
    retire!.rationale,
    /create_task was declared but never called in 90 days, while search_tasks/,
  );
  const proposal = pending.find((p) => p.kind === "merge_tools")!;
  assert.ok(proposal);
  assert.deepEqual([...proposal.sourceToolIds].sort(), ["assign_task", "find_task"]);
  const crafted = proposal.crafted as unknown as CraftedToolDefinition[];
  assert.equal(crafted[0]!.name, "find_assign_task");
  assert.deepEqual(crafted[0]!.inputSchema.required, ["assignee", "query", "taskId"]);
  assert.match(proposal.rationale, /find_task and assign_task ran together in 40 of the turns/);
  assert.equal(
    (proposal.sourceDefinitions as { id: string }[]).length,
    2,
    "the sources are frozen on the row",
  );

  assert.equal((await getCraftProposal(PROJECT_ID, proposal.id, db))?.status, "pending");
  const completed = tracked.find((t) => t.event === "tool_craft_run_completed");
  assert.equal(completed?.properties.proposals, 2);
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_craft_proposals where status = 'superseded'`,
    ),
    0,
  );
});

test("a dismissed draft stays dismissed: the next run does not raise the same change again", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await seedCatalog(db);
  await runExplorer(db);
  assert.equal((await craftProjectTools(PROJECT_ID, craftDeps(db))).proposals, 2);
  const [first] = await db
    .select()
    .from(toolCraftProposals)
    .where(eq(toolCraftProposals.status, "pending"))
    .limit(1);
  assert.ok(first);
  assert.equal(await dismissCraftProposal(PROJECT_ID, first.id, NOW, db), true);
  assert.equal(
    await dismissCraftProposal(PROJECT_ID, first.id, NOW, db),
    false,
    "only a pending draft can be dismissed",
  );
  const second = await craftProjectTools(
    PROJECT_ID,
    craftDeps(db, [], { now: () => new Date(NOW.getTime() + 60_000) }),
  );
  assert.equal(second.proposals, 1, "the dismissed change is not drafted again");
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_craft_proposals where status = 'dismissed'`,
    ),
    1,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_craft_proposals where status = 'pending'`,
    ),
    1,
  );
});

test("a second run supersedes the pending proposals of the first", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  await seedCatalog(db);
  await runExplorer(db);
  assert.equal((await craftProjectTools(PROJECT_ID, craftDeps(db))).proposals, 2);
  assert.equal(
    (
      await craftProjectTools(
        PROJECT_ID,
        craftDeps(db, [], { now: () => new Date(NOW.getTime() + 60_000) }),
      )
    ).proposals,
    2,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_craft_proposals where status = 'superseded'`,
    ),
    2,
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_craft_proposals where status = 'pending'`,
    ),
    2,
  );
});

/** One intent (Intents) whose 54 turns run find_task then assign_task in 36, as the topics job stores it. */
async function seedIntentReading(
  client: Awaited<ReturnType<typeof setupDb>>["client"],
): Promise<void> {
  const pattern = {
    withCalls: 54,
    tools: [
      { id: "find_task", turns: 40 },
      { id: "assign_task", turns: 38 },
    ],
    runs: 36,
    inOrder: 35,
    also: [],
    helpers: [],
    firsts: [{ id: "find_task", turns: 38 }],
    comesBefore: [],
    skills: { invoked: 0, offered: 0 },
  };
  await client.query(
    `insert into trace_topics (project_id, topic_id, name, input_hash) values ($1, 't_assign', 'Hand a task over', 'h'), ($1, 't_gone', 'Old', 'h')`,
    [PROJECT_ID],
  );
  await client.query(`update trace_topics set retired_at = now() where topic_id = 't_gone'`);
  await client.query(`insert into trace_topic_insights (project_id, data) values ($1, $2::jsonb)`, [
    PROJECT_ID,
    JSON.stringify({
      version: 1,
      topics: [
        { id: "t_assign", turns: 54, tasks: [], pattern },
        { id: "t_gone", turns: 60, tasks: [], pattern },
        { id: "t_small", turns: 3, tasks: [] },
      ],
    }),
  ]);
}

test("a craft run merges an intent's own two-tool pattern, read from the stored topic reading, and keeps a dismissal", async () => {
  const { client, db } = await setupDb();
  await seedCatalog(db);
  await seedIntentReading(client);
  const facts = await loadIntentPatternsForCraft(PROJECT_ID, db);
  assert.deepEqual(
    facts.map((fact) => [fact.topicId, fact.turns]),
    [["t_assign", 54]],
    "a retired intent and one without a pattern are not read",
  );
  const base = craftDeps(db);
  const withIntents = (over: Partial<CraftJobDeps> = {}) =>
    craftDeps(db, [], {
      reads: { ...base.reads!, loadIntentPatterns: (p) => loadIntentPatternsForCraft(p, db) },
      ...over,
    });

  const result = await craftProjectTools(PROJECT_ID, withIntents());
  assert.equal(result.proposals, 1);
  const [merge] = await listCraftProposals(PROJECT_ID, { statuses: ["pending"] }, db);
  assert.equal(merge?.kind, "merge_tools");
  assert.deepEqual(merge?.sourceToolIds, ["find_task", "assign_task"]);
  assert.deepEqual((merge?.evidence as { merge?: { intent?: unknown } }).merge?.intent, {
    topicId: "t_assign",
    turns: 54,
    runs: 36,
  });
  assert.doesNotMatch(
    JSON.stringify(merge),
    /Hand a task over/,
    "the intent's name is never stored on the draft",
  );

  assert.equal(await dismissCraftProposal(PROJECT_ID, merge!.id, NOW, db), true);
  const again = await craftProjectTools(
    PROJECT_ID,
    withIntents({ now: () => new Date(NOW.getTime() + 60_000) }),
  );
  assert.equal(again.proposals, 0, "dismissed by kind and tools: not raised again");
  await client.close();
});

test("a topic reading that cannot be read costs the intents' merges, never the run", async () => {
  const { client, db } = await setupDb();
  await seedCatalog(db);
  await seedIntentReading(client);
  await client.exec("drop table trace_topic_insights cascade");
  assert.deepEqual(await loadIntentPatternsForCraft(PROJECT_ID, db), []);
  const base = craftDeps(db);
  const result = await craftProjectTools(
    PROJECT_ID,
    craftDeps(db, [], {
      reads: { ...base.reads!, loadIntentPatterns: (p) => loadIntentPatternsForCraft(p, db) },
    }),
  );
  assert.equal(result.outcome, "crafted");
  await client.close();
});

test("dismissing a drafted change dismisses every pending draft of it, and nothing else", async () => {
  const { client, db } = await setupDb();
  await client.query(
    `insert into tool_craft_runs (id, project_id, trigger, status, created_at) values ('55555555-5555-4555-8555-555555555555', $1, 'chained', 'crafted', $2)`,
    [PROJECT_ID, NOW.toISOString()],
  );
  const ids = [
    "66666666-6666-4666-8666-666666666661",
    "66666666-6666-4666-8666-666666666662",
    "66666666-6666-4666-8666-666666666663",
  ];
  for (const [id, kind, tools] of [
    [ids[0], "merge_tools", "{find_task,assign_task}"],
    [ids[1], "merge_tools", "{assign_task,find_task}"],
    [ids[2], "merge_tools", "{find_task,notify}"],
  ] as const) {
    await client.query(
      `insert into tool_craft_proposals (id, run_id, project_id, kind, status, source_tool_ids, source_definitions, crafted, rationale, evidence, created_at)
       values ($1, '55555555-5555-4555-8555-555555555555', $2, $3, 'pending', $4, '[]'::jsonb, '[]'::jsonb, 'x', '{}'::jsonb, $5)`,
      [id, PROJECT_ID, kind, tools, NOW.toISOString()],
    );
  }
  assert.equal(await dismissCraftProposal(PROJECT_ID, ids[0]!, NOW, db), true);
  const rows = (
    await client.query<{ id: string; status: string }>(
      `select id, status from tool_craft_proposals order by id`,
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.status),
    ["dismissed", "dismissed", "pending"],
    "the same two tools in any order are one change",
  );
  assert.equal(
    await dismissCraftProposal(PROJECT_ID, ids[1]!, NOW, db),
    false,
    "already dismissed",
  );
  assert.equal(
    await dismissCraftProposal("33333333-3333-4333-8333-333333333333", ids[2]!, NOW, db),
    false,
    "another project's draft is never touched",
  );
  await client.close();
});
