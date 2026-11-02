import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { fixtureRows, type TurnFixture, turn } from "@/lib/ledger/test-support";
import { organizations } from "@/lib/platform/identity/schema";
import { computeToolExplorer } from "@/lib/readings/tool-explorer/compute";
import {
  type ExploreJobDeps,
  exploreProjectToolUsage,
  exploreSeams,
} from "@/lib/readings/tool-explorer/job";
import {
  errorMessagesFor,
  intentsForTurns,
  listSessionTurns,
  loadIntentTexts,
} from "@/lib/readings/tool-explorer/ledger";
import {
  enqueueExploreJob,
  failExplorerRun,
  latestExplorerRun,
  listCousage,
  listIntentTools,
  listMergeCandidates,
  listTransitions,
  persistExplorerRun,
  reapStaleExplorerRuns,
  startExplorerRun,
} from "@/lib/readings/tool-explorer/queries";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  count,
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
  type Tracked,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadPreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";

const SIGNAL_RUN_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-02T00:00:00Z");

/**
 * Three habits planted in the ledger:
 * - `find_task` then `assign_task` inside one turn, 40 times, and never apart:
 *   the merge candidate;
 * - `search_tasks` alone 130 times;
 * - `lookup` in one turn and `report` in the next turn of the same session,
 *   30 sessions: together only at session scope.
 */
function fixtures() {
  const chained = times(30, (i) => {
    const first = turn({ session: `pair-${i}` })
      .search(["lookup"])
      .invoke("lookup");
    const second = turn({ after: first, gapMs: 120_000 }).search(["report"]).invoke("report");
    return [first, second];
  }).flat();
  return [
    ...times(130, () => fresh().search(["create_task", "search_tasks"]).invoke("search_tasks")),
    ...times(40, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
    ...chained,
  ];
}

const HANDOFF_INTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REPORT_INTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

/**
 * What the categorize job would have written: one intent on every search for
 * `find_task` ("hand a task to someone") and one on every `lookup` search
 * ("weekly report"), pointing at the fixture search events by id.
 */
async function seedIntents(client: PGlite, fixtures: readonly TurnFixture[]): Promise<void> {
  await client.query(
    `insert into query_intents (id, project_id, normalized_text, text, occurrences) values
       ($1, $3, 'hand a task to someone', 'Hand a task to someone', 40),
       ($2, $3, 'weekly report', 'Weekly report', 30)`,
    [HANDOFF_INTENT, REPORT_INTENT, PROJECT_ID],
  );
  const { rows } = fixtureRows(fixtures);
  for (const row of rows) {
    if (row.type !== "search" || !row.query) continue;
    const intent = row.query.includes("find_task")
      ? HANDOFF_INTENT
      : row.query.includes("lookup")
        ? REPORT_INTENT
        : null;
    if (!intent) continue;
    await client.query(
      `insert into query_intent_occurrences (query_intent_id, project_id, trace_event_id, intent_index, query, session_id, occurred_at)
       values ($1, $2, $3, 0, $4, $5, $6)`,
      [
        intent,
        PROJECT_ID,
        row.id,
        row.query,
        row.sessionId,
        (row.occurredAt ?? row.receivedAt).toISOString(),
      ],
    );
  }
}

function exploreDeps(
  db: Db,
  now: Date,
  tracked: Tracked[] = [],
  over: Partial<ExploreJobDeps> = {},
): Partial<ExploreJobDeps> {
  return {
    getOrganizationByProjectId: async () => {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, "22222222-2222-4222-8222-222222222222"));
      return org ?? null;
    },
    reapStale: (p, before, _db, at) => reapStaleExplorerRuns(p, before, db, at),
    startRun: (input, _db, at) => startExplorerRun(input, db, at),
    failRun: (id, error, _db, at) => failExplorerRun(id, error, db, at),
    persist: (input) => persistExplorerRun(input, db),
    compute: (projectId, window, options) =>
      computeToolExplorer(projectId, window, {
        ...options,
        listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
        loadWorkflows: (p) => loadPreviousWorkflows(p, db),
        intentsForTurns: (p, turns) => intentsForTurns(p, turns, db),
        loadIntentTexts: (p, ids) => loadIntentTexts(p, ids, db),
        loadErrorMessages: (p, ids) => errorMessagesFor(p, ids, db),
        analysis: { cousage: { minSupport: 5, minShare: 0 } },
      }),
    observability: {
      trackSystemEvent: async (event, _id, properties) => {
        tracked.push({ event, properties });
      },
    },
    now: () => now,
    ...over,
  };
}

test("a signal run queues the explorer, whose run stores edges and sets for both scopes", async () => {
  const { client, db } = await setupDb();
  const seeded = fixtures();
  await seedLedger(client, db, seeded);
  await seedIntents(client, seeded);
  const queued: string[] = [];
  const signalResult = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, [], {
      enqueueExplore: async (projectId, signalRunId) => {
        queued.push(signalRunId);
        return enqueueExploreJob(projectId, "chained", signalRunId, db);
      },
    }),
  );
  assert.equal(signalResult.outcome, "completed");
  assert.deepEqual(
    queued,
    [signalResult.runId],
    "the explorer is queued with the signal run that just finished",
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from jobs where kind = 'explore_tool_usage' and status = 'queued'`,
    ),
    1,
  );
  assert.equal(
    await enqueueExploreJob(PROJECT_ID, "manual", null, db),
    null,
    "a second enqueue coalesces",
  );

  const tracked: Tracked[] = [];
  const crafted: string[] = [];
  const result = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "chained", signalRunId: signalResult.runId },
    exploreDeps(db, NOW, tracked, { enqueueCraft: async (p) => crafted.push(p) }),
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(crafted, [PROJECT_ID], "the crafter is queued once the reading is stored");
  assert.equal(result.turnsScanned, 230);
  assert.equal(
    result.sessionsScanned,
    200,
    "130 + 40 single-turn sessions and 30 two-turn sessions",
  );
  assert.equal(result.windowDays, 90);

  const run = await latestExplorerRun(PROJECT_ID, db);
  assert.equal(run?.status, "completed");
  assert.equal(run?.signalRunId, signalResult.runId);
  const summary = run?.summary as {
    units: Record<string, { units: number; multiUnits: number }>;
    nodes: { id: string }[];
  };
  assert.deepEqual(summary.units, {
    turn: { units: 230, multiUnits: 40 },
    session: { units: 200, multiUnits: 70 },
  });
  assert.ok(summary.nodes.some((n) => n.id === "search_tasks"));

  const turnNext = await listTransitions(
    PROJECT_ID,
    { scope: "turn", kind: "next", from: "find_task" },
    db,
  );
  assert.equal(turnNext.length, 1);
  assert.equal(turnNext[0]!.b, "assign_task");
  assert.equal(turnNext[0]!.p, 1);
  assert.equal(turnNext[0]!.n, 40);

  const sessionBefore = await listTransitions(
    PROJECT_ID,
    { scope: "session", kind: "before", from: "lookup" },
    db,
  );
  assert.deepEqual(
    sessionBefore.map((e) => [e.b, e.n, e.nA]),
    [["report", 30, 30]],
  );
  assert.equal(
    (await listTransitions(PROJECT_ID, { scope: "turn", kind: "before", from: "lookup" }, db))
      .length,
    0,
    "lookup and report never share a turn",
  );

  const sessionSets = await listCousage(PROJECT_ID, { scope: "session", tool: "report" }, db);
  assert.deepEqual(
    sessionSets.map((s) => [s.key, s.support, s.jaccard]),
    [["lookup|report", 30, 1]],
  );

  const merges = await listMergeCandidates(PROJECT_ID, { scope: "turn" }, db);
  assert.deepEqual(
    merges.map((s) => s.key),
    ["assign_task|find_task"],
    "40 of 40 clears the 0.9 bound; 30 of 30 does not",
  );
  const sessionMerges = await listMergeCandidates(
    PROJECT_ID,
    { scope: "session", minJaccardLow: 0.85 },
    db,
  );
  assert.deepEqual(sessionMerges.map((s) => s.key).sort(), [
    "assign_task|find_task",
    "lookup|report",
  ]);

  const pairSignal = (await latestSignalRun(PROJECT_ID, db))?.summary as {
    workflows?: { items: { id: string; coreTools: string[] }[] };
  };
  const workflow = pairSignal.workflows?.items.find(
    (w) => w.coreTools.join("|") === "assign_task|find_task",
  );
  if (workflow) {
    assert.equal(
      merges[0]!.workflowId,
      workflow.id,
      "a set that is a workflow core carries its id",
    );
  }

  const session = await listSessionTurns(PROJECT_ID, "pair-3", db);
  assert.equal(session.length, 2);
  assert.deepEqual(
    session.map(({ steps }) => steps.filter((s) => s.kind === "invoke").map((s) => s.targetId)),
    [["lookup"], ["report"]],
  );

  // The intent join: every find_task search carried the handoff intent, every
  // lookup search the report intent; at session scope the report intent's turn
  // and the `report` call are different turns of one session.
  assert.equal(run?.turnsWithIntents, 70);
  const handoff = await listIntentTools(
    PROJECT_ID,
    { scope: "turn", intentId: HANDOFF_INTENT },
    db,
  );
  assert.deepEqual(
    handoff.map((r) => [r.toolId, r.n, r.intentUnits, r.intentText]),
    [
      ["assign_task", 40, 40, "Hand a task to someone"],
      ["find_task", 40, 40, "Hand a task to someone"],
    ],
  );
  const reportTurn = await listIntentTools(
    PROJECT_ID,
    { scope: "turn", intentId: REPORT_INTENT },
    db,
  );
  assert.deepEqual(
    reportTurn.map((r) => [r.toolId, r.n]),
    [["lookup", 30]],
    "inside the turn only the lookup ran",
  );
  const reportSession = await listIntentTools(
    PROJECT_ID,
    { scope: "session", intentId: REPORT_INTENT },
    db,
  );
  assert.deepEqual(
    reportSession.map((r) => [r.toolId, r.n]),
    [
      ["lookup", 30],
      ["report", 30],
    ],
    "across the session the report call joins the ask",
  );
  const groups = (run?.summary as { intentGroups?: { intentIds: string[] }[] }).intentGroups ?? [];
  assert.equal(groups.length, 2, "two asks with no words in common are two groups");

  const completed = tracked.find((t) => t.event === "tool_explorer_run_completed");
  assert.equal(completed?.properties.object_action, "tool_explorer_run_completed");
  assert.equal(completed?.properties.sessions_scanned, 200);
  assert.equal(completed?.properties.turns_with_intents, 70);
});

test("a new run replaces the previous completed one, and only one live run exists at a time", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  const first = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    exploreDeps(db, NOW),
  );
  assert.equal(first.outcome, "completed");
  const edgesBefore = await count(client, `select count(*)::int as n from tool_explorer_edges`);
  assert.ok(edgesBefore > 0);

  const later = new Date(NOW.getTime() + 60_000);
  const second = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    exploreDeps(db, later),
  );
  assert.equal(second.outcome, "completed");
  assert.equal(
    await count(client, `select count(*)::int as n from tool_explorer_runs`),
    1,
    "the earlier completed run is gone",
  );
  assert.equal(
    await count(client, `select count(*)::int as n from tool_explorer_edges`),
    edgesBefore,
    "its rows cascaded",
  );
  assert.equal((await latestExplorerRun(PROJECT_ID, db))?.id, second.runId);

  const live = await startExplorerRun(
    {
      projectId: PROJECT_ID,
      trigger: "manual",
      windowDays: 30,
      windowStart: NOW,
      windowEnd: later,
      signalRunId: null,
    },
    db,
    later,
  );
  assert.ok(live);
  const requeued: unknown[] = [];
  const busy = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "chained", signalRunId: SIGNAL_RUN_ID },
    exploreDeps(db, later, [], {
      requeue: async (projectId, payload) => (requeued.push([projectId, payload]), { id: "job-2" }),
    }),
  );
  assert.equal(busy.outcome, "busy");
  assert.deepEqual(
    requeued,
    [[PROJECT_ID, { trigger: "chained", signalRunId: SIGNAL_RUN_ID }]],
    "a job that met a live run is queued again, payload intact, so its reading still happens",
  );

  const stale = new Date(later.getTime() + 20 * 60_000);
  const afterReap = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    exploreDeps(db, stale),
  );
  assert.equal(
    afterReap.outcome,
    "completed",
    "a live run older than the reaper's window is failed and the project moves on",
  );
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from tool_explorer_runs where status = 'failed' and error = 'stale'`,
    ),
    1,
  );
});

test("the crafter seam is empty until its registration fills it, and a run completes without it", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures());
  assert.equal(exploreSeams.enqueueCraft, undefined, "nothing in L4 fills the crafter's seam");
  // `exploreDeps` sets no `enqueueCraft`, so the run reads the (empty) seam.
  const result = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    exploreDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");
  assert.equal((await latestExplorerRun(PROJECT_ID, db))?.status, "completed");
  assert.equal(
    await count(client, `select count(*)::int as n from jobs where kind = 'craft_tools'`),
    0,
    "no crafter: nothing is queued",
  );

  // A crafter enqueue that throws never fails the run.
  const later = new Date(NOW.getTime() + 60_000);
  const failing = await exploreProjectToolUsage(
    PROJECT_ID,
    { trigger: "manual", signalRunId: null },
    exploreDeps(db, later, [], {
      enqueueCraft: async () => {
        throw new Error("crafter queue down");
      },
    }),
  );
  assert.equal(failing.outcome, "completed");
});
