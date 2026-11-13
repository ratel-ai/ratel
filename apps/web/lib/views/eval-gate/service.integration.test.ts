import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { fixEvalRuns, fixEvalSets } from "@/lib/views/eval-gate/schema";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";
import { loadEvalGatePage } from "./page-model";
import { loadRuns } from "./runs";
import {
  addRunToSet,
  type EvalGateDeps,
  EvalGateError,
  ensureEvalSet,
  executeEvalRun,
  listEvalBadges,
  resolveFixProject,
  runSimulation,
  topUpEvalSet,
} from "./service";
import { searchFor } from "./simulate";
import {
  getEvalRun,
  getEvalSet,
  listCases,
  listEvalRuns,
  removeCase,
  STALE_EVAL_RUN_ERROR,
  STALE_EVAL_RUN_MS,
  updateCase,
} from "./store";
import { NO_EXPECTATION } from "./types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "44444444-4444-4444-8444-444444444441";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_ISSUE = "44444444-4444-4444-8444-444444444442";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const turnId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const eventId = (n: number, k: number) =>
  `bbbbbbbb-bbbb-4bbb-8bbb-${String(n * 10 + k).padStart(12, "0")}`;

type Db = ReturnType<typeof getDb>;

/**
 * One project with four tools and six runs: four asked where an order is and
 * were served `track_parcel` and `notify` (the issue's evidence is two of
 * them), one tracked a parcel, one found a task. The fix rewrites
 * `get_purchase`'s searchable description, which shares no word with those
 * asks today, so they find it.
 */
async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  const tools: Record<string, string> = {
    get_purchase: "Fetch a purchase record by reference.",
    track_parcel: "Track where a parcel is on its way, with its status.",
    notify: "Tell the owner where things stand and the latest status.",
    find_task: "Find a task.",
  };
  await upsertRuntimeCatalogEntries(
    Object.entries(tools).map(([id, text]) => ({
      projectId: PROJECT,
      kind: "tool" as const,
      entryId: id,
      name: id,
      description: text,
      searchableDescription: text,
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
  const runs: { n: number; query: string; hits: string[]; ran: string }[] = [
    {
      n: 1,
      query: "where is my order status",
      hits: ["track_parcel", "notify"],
      ran: "get_purchase",
    },
    { n: 2, query: "order status please", hits: ["track_parcel", "notify"], ran: "get_purchase" },
    { n: 3, query: "where is my order", hits: ["track_parcel", "find_task"], ran: "get_purchase" },
    { n: 4, query: "status of my order", hits: ["track_parcel", "notify"], ran: "get_purchase" },
    { n: 5, query: "track my parcel", hits: ["track_parcel", "get_purchase"], ran: "track_parcel" },
    { n: 6, query: "find my task", hits: ["find_task"], ran: "find_task" },
  ];
  for (const run of runs) {
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, search_count, invoke_count)
       values ($1, $2, $3, $4, 'declared', 'runtime', 'closed', $5, $5, $5, 1, 1)`,
      [turnId(run.n), PROJECT, `s-${run.n}`, `declared:${run.n}`, at(100 - run.n)],
    );
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, query, payload)
       values ($1, $2, 'search', $3, $4, $4, $5, $6, $7, '{}'::jsonb), ($8, $2, 'invoke_end', $3, $4, $4, $9, $6, null, '{}'::jsonb)`,
      [
        eventId(run.n, 1),
        PROJECT,
        `s-${run.n}`,
        at(100 - run.n),
        `c-${run.n}-1`,
        `trace-${run.n}`,
        run.query,
        eventId(run.n, 2),
        `c-${run.n}-2`,
      ],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_ordinal, search_type, hit_ids, hit_count)
       values ($1, $2, 1, 'search', 'search', $3, $4, $4, 1, 'search', $5, $6)`,
      [turnId(run.n), PROJECT, eventId(run.n, 1), at(100 - run.n), run.hits, run.hits.length],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
       values ($1, $2, 2, 'invoke', 'invoke_end', $3, $4, $4, 'tool', $5, 'ok')`,
      [turnId(run.n), PROJECT, eventId(run.n, 2), at(100 - run.n), run.ran],
    );
  }
  await client.query(
    `insert into trace_signals (id, project_id, kind, subject_kind, subject_key, subject, status, severity, impact, n, metrics, evidence, first_seen_at, last_seen_at)
     values ($1, $2, 'first_try_miss', 'tool', 'get_purchase', '{"ids":["get_purchase"]}', 'open', 0.4, 30, 300, '{}', $3::jsonb, $4, $4)`,
    [ISSUE, PROJECT, JSON.stringify({ turnIds: [turnId(2), turnId(1)], totalTurns: 2 }), at(10)],
  );
  return { client, db };
}

/** The rewrite fix of Fixes' own fixtures, pointed at this project's issue. */
function rewriteFix(): Fix {
  const fix = buildFixes(fixesInput()).open.find((item) => item.source === "rewrite");
  assert.ok(fix);
  return {
    ...fix,
    subject: { ...fix.subject, tools: [{ id: "get_purchase", label: "get_purchase", href: "" }] },
    issues: [
      {
        id: ISSUE,
        kind: "first_try_miss",
        title: "Missed on the first try",
        claim: "",
        cost: "",
        figure: null,
        href: `/project/${PROJECT}/health#signal-${ISSUE}`,
      },
    ],
    detail:
      fix.detail.source === "rewrite"
        ? {
            ...fix.detail,
            row: {
              ...fix.detail.row,
              toolId: "get_purchase",
              proposed:
                "Fetch a purchase record by reference. Where is my order, order status, my order.",
            },
          }
        : fix.detail,
  };
}

function deps(db: Db, fix: Fix, enqueued: string[] = []): Partial<EvalGateDeps> {
  return {
    db,
    // No model configured: nothing is called, criteria read "not judged".
    models: { agent: null, tool: null, judge: null, standIn: false },
    loadFix: async (projectId, id) =>
      projectId === PROJECT && (id === fix.id || fix.aliases.includes(id))
        ? { projectId, fix }
        : null,
    loadCorpus: (projectId) => loadToolCorpus(projectId, db),
    enqueue: async (_projectId, runId) => {
      enqueued.push(runId);
      return null;
    },
  };
}

test("runSimulation holds the issue's own runs out: the tool's other runs grade the rewrite, the evidence is scored apart", async () => {
  const { client, db } = await setup();
  try {
    const fix = rewriteFix();
    // RC-77: before any set exists, the page names the kind's method (a merge is replayed, never re-ranked).
    assert.equal((await loadEvalGatePage(PROJECT, fix.id, fix, db)).method, "rerank");
    assert.equal(
      (await loadEvalGatePage(PROJECT, fix.id, { ...fix, kind: "merge" }, db)).method,
      "replay",
    );
    const outcome = await runSimulation(fix.id, {
      projectId: PROJECT,
      trigger: "mcp",
      deps: deps(db, fix),
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.fixId, fix.id);
    assert.deepEqual(outcome.source, {
      stage: "insights",
      kind: "insight",
      id: ISSUE,
      label: "Missed on the first try",
      href: `/project/${PROJECT}/health#signal-${ISSUE}`,
    });
    assert.equal(outcome.eval.stage, "improve");
    assert.equal(
      outcome.href,
      `/project/${PROJECT}/improvement/fixes/${encodeURIComponent(fix.id)}/eval`,
    );
    assert.equal(outcome.eval.href, outcome.href, "the eval ref opens on the fix's eval page");

    // The eval is linked to its fix in the lineage spine (RC-45), so chainOf walks it back.
    const { rows: links } = await client.query<{
      kind: string;
      object_id: string;
      source_kind: string;
      source_id: string;
    }>(`select kind, object_id, source_kind, source_id from lineage_links where project_id = $1`, [
      PROJECT,
    ]);
    assert.deepEqual(links, [
      { kind: "eval", object_id: outcome.setId, source_kind: "fix", source_id: fix.id },
    ]);

    const set = await getEvalSet(PROJECT, fix.id, db);
    assert.ok(set);
    assert.deepEqual([...set.evidenceTurnIds].sort(), [turnId(1), turnId(2)]);
    const cases = await listCases(set.id, db);
    // RC-61: the holdout first (runs that ran the tool, then runs only offered it; never the issue's), then the issue's own runs.
    assert.deepEqual(
      cases.map((item) => [item.turnId, item.origin]),
      [
        [turnId(4), "tool"],
        [turnId(3), "tool"],
        [turnId(5), "tool"],
        [turnId(2), "issue"],
        [turnId(1), "issue"],
      ],
    );
    assert.ok(
      !cases.some((item) => item.turnId === turnId(6)),
      "a run that never saw the tool is not picked",
    );
    assert.equal(cases[0]!.expected.tool, "get_purchase");
    assert.equal(cases[0]!.traceId, "trace-4");

    // The verdict and "N runs" read the holdout only; the evidence has its own pass rates.
    assert.equal(outcome.nCases, 3);
    assert.equal(outcome.nSimulated, 3);
    assert.equal(outcome.label, "Simulated on 3 historical runs");
    assert.ok(outcome.before && outcome.after);
    assert.deepEqual([outcome.before.passed, outcome.after.passed], [1, 3]);
    assert.deepEqual(
      outcome.evidence && [
        outcome.evidence.nSimulated,
        outcome.evidence.before.passed,
        outcome.evidence.after.passed,
      ],
      [2, 0, 2],
    );
    assert.deepEqual(
      outcome.methods && [outcome.methods.rerank, outcome.methods.replay, outcome.methods.none],
      [3, 0, 0],
    );
    assert.equal(outcome.spend, null, "a re-rank calls no model");
    assert.ok(outcome.verdict === "better" || outcome.verdict === "same", outcome.verdict ?? "");

    // A second call reuses the set and adds a simulation.
    const again = await runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix) });
    assert.equal(again.setId, outcome.setId);
    assert.notEqual(again.runId, outcome.runId);
  } finally {
    await client.close();
  }
});

test("people edit the set: change an expected outcome, remove a run, add one by trace id; the badge goes stale until re-run", async () => {
  const { client, db } = await setup();
  try {
    const fix = rewriteFix();
    await runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix) });
    const set = (await getEvalSet(PROJECT, fix.id, db))!;
    const cases = await listCases(set.id, db);

    assert.ok(
      await updateCase(
        set.id,
        cases[0]!.id,
        {
          expected: { ...NO_EXPECTATION, tool: "get_purchase", maxToolCalls: 1 },
          outcome: "Finds the order first.",
          criteria: "Order asks only.",
        },
        db,
      ),
    );
    assert.ok(await removeCase(set.id, cases[1]!.id, db));
    assert.equal(await removeCase(set.id, cases[1]!.id, db), false);
    const added = await addRunToSet(set, fix, "trace-6", deps(db, fix));
    assert.deepEqual(added, { ok: true, added: true });
    assert.deepEqual(await addRunToSet(set, fix, "trace-404", deps(db, fix)), {
      ok: false,
      reason: "not-found",
    });

    const edited = await listCases(set.id, db);
    assert.equal(edited.length, cases.length);
    assert.equal(edited[0]!.outcome, "Finds the order first.");
    assert.equal(edited.at(-1)!.origin, "manual");

    const stale = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(stale?.state, "done");
    assert.equal(stale?.state === "done" && stale.stale, true);

    // Background: queued, then the job runs it.
    const enqueued: string[] = [];
    const queued = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.equal(queued.status, "queued");
    assert.deepEqual(enqueued, [queued.runId]);
    assert.equal((await listEvalBadges(PROJECT, db))[fix.id]?.state, "pending");
    // A second request while one is queued joins it.
    const joined = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.equal(joined.runId, queued.runId);
    assert.equal(enqueued.length, 1);

    const done = await executeEvalRun(queued.runId, deps(db, fix));
    assert.equal(done?.status, "completed");
    const fresh = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(fresh?.state === "done" && fresh.stale, false);

    const page = await loadEvalGatePage(PROJECT, fix.id, fix, db);
    assert.equal(page.cases.length, edited.length);
    assert.equal(
      page.cases[0]!.expectedText,
      "Finds get_purchase in the first list, at most 1 call",
    );
    // A run that wanted another tool guards against collateral damage: it keeps its tool in the list.
    const guard = page.cases.find((item) => item.turnId === turnId(6));
    assert.equal(guard?.expected.tool, "find_task");
    assert.equal(guard?.result?.after?.pass, true);
    assert.equal(page.history.length, 2);
    assert.ok(page.set?.change[0]?.includes("searchable description"));
    assert.equal(page.set?.method, "rerank");
    assert.equal(page.cases.find((item) => item.turnId === turnId(2))?.role, "evidence");
    assert.equal(page.cases.find((item) => item.turnId === turnId(6))?.role, "holdout");
    // The edited run has criteria; with no model configured they are shown, not scored.
    assert.equal(page.latest?.judge, "Criteria not judged: no model configured");
    const judged = page.cases[0]!.result?.after?.checks.find((check) => check.kind === "criteria");
    assert.equal(judged?.measured, false);
  } finally {
    await client.close();
  }
});

test("a fix id resolves to its project; a fix that is gone says so", async () => {
  const { client, db } = await setup();
  try {
    assert.equal(await resolveFixProject(`issue:${ISSUE}`, db), PROJECT);
    assert.equal(await resolveFixProject("issue:not-a-uuid", db), null);
    assert.equal(await resolveFixProject("nonsense", db), null);
    const fix = rewriteFix();
    await assert.rejects(
      runSimulation("craft:66666666-6666-4666-8666-666666666666", {
        projectId: PROJECT,
        deps: deps(db, fix),
      }),
      /isn't open/,
    );
    await assert.rejects(
      runSimulation("craft:66666666-6666-4666-8666-666666666666", { deps: deps(db, fix) }),
      /No project/,
    );
  } finally {
    await client.close();
  }
});

test("a run whose enqueue throws is failed, so the next request queues a fresh one", async () => {
  const { client, db } = await setup();
  try {
    const fix = rewriteFix();
    const broken: Partial<EvalGateDeps> = {
      ...deps(db, fix),
      enqueue: async () => {
        throw new Error("queue down");
      },
    };
    await assert.rejects(
      runSimulation(fix.id, { projectId: PROJECT, background: true, deps: broken }),
      /queue down/,
    );
    const set = (await getEvalSet(PROJECT, fix.id, db))!;
    const [stuck] = await listEvalRuns(set.id, 10, db);
    assert.equal(stuck?.status, "failed");
    assert.equal(stuck?.error, "Couldn't queue the simulation.");
    assert.equal((await listEvalBadges(PROJECT, db))[fix.id]?.state, "failed");

    const enqueued: string[] = [];
    const next = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.notEqual(next.runId, stuck!.id);
    assert.equal(next.status, "queued");
    assert.deepEqual(enqueued, [next.runId]);
  } finally {
    await client.close();
  }
});

test("a live run past the timeout reads as failed and is replaced by the next request", async () => {
  const { client, db } = await setup();
  try {
    const fix = rewriteFix();
    const enqueued: string[] = [];
    // Running since before the timeout: its worker died and the jobs reaper gave up on the job.
    const dead = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    const old = new Date(Date.now() - STALE_EVAL_RUN_MS - 60_000);
    await db
      .update(fixEvalRuns)
      .set({ status: "running", startedAt: old, createdAt: old })
      .where(eq(fixEvalRuns.id, dead.runId));
    assert.equal(
      (await listEvalBadges(PROJECT, db))[fix.id]?.state,
      "failed",
      "the poller stops on a run that will never finish",
    );

    const next = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.notEqual(next.runId, dead.runId);
    assert.equal(next.status, "queued");
    assert.deepEqual(enqueued, [dead.runId, next.runId]);
    const reaped = await getEvalRun(dead.runId, db);
    assert.equal(reaped?.status, "failed");
    assert.equal(reaped?.error, STALE_EVAL_RUN_ERROR);
    assert.ok(reaped?.finishedAt);

    // A dead queued run (its job never ran) is reaped the same way, counted from when it was queued.
    await db.update(fixEvalRuns).set({ createdAt: old }).where(eq(fixEvalRuns.id, next.runId));
    const third = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.notEqual(third.runId, next.runId);
    assert.equal((await getEvalRun(next.runId, db))?.status, "failed");

    // A fresh live run is still joined, not reaped.
    const joined = await runSimulation(fix.id, {
      projectId: PROJECT,
      background: true,
      deps: deps(db, fix, enqueued),
    });
    assert.equal(joined.runId, third.runId);
    assert.equal(enqueued.length, 3);

    // The stale run's job, if it ever runs, finds nothing to claim and leaves the failure as is.
    assert.equal((await executeEvalRun(dead.runId, deps(db, fix)))?.status, "failed");
  } finally {
    await client.close();
  }
});

test("re-reading the set or picking runs with nothing new doesn't mark the last simulation stale", async () => {
  const { client, db } = await setup();
  try {
    const fix = rewriteFix();
    await runSimulation(fix.id, { projectId: PROJECT, deps: deps(db, fix) });
    const before = (await getEvalSet(PROJECT, fix.id, db))!;
    const fresh = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(fresh?.state === "done" && fresh.stale, false);

    // The eval page's actions re-read the set (create, add from history) on an unchanged fix.
    const { set, created } = await ensureEvalSet(
      { projectId: PROJECT, fix },
      "user_1",
      deps(db, fix),
    );
    assert.equal(created, false);
    assert.equal(set.updatedAt.getTime(), before.updatedAt.getTime());
    assert.equal(await topUpEvalSet(set, fix, deps(db, fix)), 0);
    await ensureEvalSet({ projectId: PROJECT, fix }, "user_1", deps(db, fix));

    assert.equal(
      (await getEvalSet(PROJECT, fix.id, db))!.updatedAt.getTime(),
      before.updatedAt.getTime(),
    );
    const still = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(still?.state, "done");
    assert.equal(still?.state === "done" && still.stale, false, "an unchanged set reads as fresh");

    // A redrafted fix is a real change: the set takes it and the badge goes stale.
    const redrafted: Fix = { ...fix, short: `${fix.short} (redrafted)` };
    const { set: changed } = await ensureEvalSet(
      { projectId: PROJECT, fix: redrafted },
      "user_1",
      deps(db, redrafted),
    );
    assert.equal(changed.title, redrafted.short);
    assert.ok(changed.updatedAt.getTime() > before.updatedAt.getTime());
    const stale = (await listEvalBadges(PROJECT, db))[fix.id];
    assert.equal(stale?.state === "done" && stale.stale, true);
  } finally {
    await client.close();
  }
});

test("with a projectId, a fix of another project is not found, even though its own row names that project", async () => {
  const { client, db } = await setup();
  try {
    await client.exec(
      `insert into projects (id, organization_id, name, slug) values ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');`,
    );
    await client.query(
      `insert into trace_signals (id, project_id, kind, subject_kind, subject_key, subject, status, severity, impact, n, metrics, evidence, first_seen_at, last_seen_at)
       values ($1, $2, 'first_try_miss', 'tool', 'get_purchase', '{"ids":["get_purchase"]}', 'open', 0.4, 30, 300, '{}', '{}'::jsonb, $3, $3)`,
      [OTHER_ISSUE, OTHER_PROJECT, at(10)],
    );
    const fixId = `issue:${OTHER_ISSUE}`;
    assert.equal(await resolveFixProject(fixId, db), OTHER_PROJECT);
    const other: Fix = { ...rewriteFix(), id: fixId, aliases: [] };
    // Fixes are read per project: this one exists only in the other project.
    const scoped: Partial<EvalGateDeps> = {
      ...deps(db, other),
      loadFix: async (projectId, id) =>
        projectId === OTHER_PROJECT && id === fixId ? { projectId, fix: other } : null,
    };

    await assert.rejects(
      runSimulation(fixId, { projectId: PROJECT, deps: scoped }),
      (err: unknown) => err instanceof EvalGateError && err.code === "fix-not-found",
    );
    await assert.rejects(
      runSimulation(fixId, { projectId: PROJECT, background: true, deps: scoped }),
      (err: unknown) => err instanceof EvalGateError && err.code === "fix-not-found",
    );
    assert.equal(await getEvalSet(PROJECT, fixId, db), null);
    assert.equal(
      await getEvalSet(OTHER_PROJECT, fixId, db),
      null,
      "nothing is made in the fix's own project either",
    );
    const sets = await db.select().from(fixEvalSets);
    assert.equal(sets.length, 0);
  } finally {
    await client.close();
  }
});

test("a run's skill lookup is read as one, so the right-tool check reads the tool search after it (RC-77)", async () => {
  const { client, db } = await setup();
  try {
    const n = 7;
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, search_count, invoke_count)
       values ($1, $2, $3, $4, 'declared', 'runtime', 'closed', $5, $5, $5, 2, 1)`,
      [turnId(n), PROJECT, `s-${n}`, `declared:${n}`, at(1)],
    );
    await client.query(
      `insert into trace_events (id, project_id, type, session_id, occurred_at, received_at, client_event_id, trace_id, query, payload)
       values ($1, $2, 'skill_search', $3, $4, $4, $5, $6, 'order helper', '{}'::jsonb),
              ($7, $2, 'search', $3, $4, $4, $8, $6, 'where is my order', '{}'::jsonb),
              ($9, $2, 'invoke_end', $3, $4, $4, $10, $6, null, '{}'::jsonb)`,
      [
        eventId(n, 1),
        PROJECT,
        `s-${n}`,
        at(1),
        `c-${n}-1`,
        `trace-${n}`,
        eventId(n, 2),
        `c-${n}-2`,
        eventId(n, 3),
        `c-${n}-3`,
      ],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, search_ordinal, search_type, hit_ids, hit_count)
       values ($1, $2, 1, 'search', 'skill_search', $3, $4, $4, 1, 'skill_search', '{order-helper}', 1),
              ($1, $2, 2, 'search', 'search', $5, $4, $4, 2, 'search', '{track_parcel,notify}', 2)`,
      [turnId(n), PROJECT, eventId(n, 1), at(1), eventId(n, 2)],
    );
    await client.query(
      `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome)
       values ($1, $2, 3, 'invoke', 'invoke_end', $3, $4, $4, 'tool', 'get_purchase', 'ok')`,
      [turnId(n), PROJECT, eventId(n, 3), at(1)],
    );
    const run = (await loadRuns(PROJECT, [turnId(n)], db)).get(turnId(n));
    assert.ok(run);
    assert.deepEqual(
      run.steps
        .filter((step) => step.kind === "search")
        .map((step) => step.kind === "search" && [step.searchType, step.query]),
      [
        ["skill_search", "order helper"],
        ["search", "where is my order"],
      ],
    );
    assert.equal(searchFor(run, "get_purchase")?.query, "where is my order");
  } finally {
    await client.close();
  }
});

test("a rewrite with no drafted text is refused before any set or run exists (RC-77)", async () => {
  const { client, db } = await setup();
  try {
    const drafted = rewriteFix();
    const fix: Fix =
      drafted.detail.source === "rewrite"
        ? {
            ...drafted,
            detail: { ...drafted.detail, row: { ...drafted.detail.row, proposed: "  " } },
          }
        : drafted;
    const enqueued: string[] = [];
    await assert.rejects(
      runSimulation(fix.id, {
        projectId: PROJECT,
        trigger: "manual",
        background: true,
        deps: deps(db, fix, enqueued),
      }),
      (err: unknown) =>
        err instanceof EvalGateError &&
        err.code === "nothing-to-simulate" &&
        /no drafted text/.test(err.message),
    );
    assert.equal(await getEvalSet(PROJECT, fix.id, db), null);
    assert.equal(enqueued.length, 0);
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from fix_eval_runs",
    );
    assert.equal(rows[0]!.n, 0);
    // The page says why and disables the button.
    const page = await loadEvalGatePage(PROJECT, fix.id, fix, db);
    assert.match(page.blocked ?? "", /no drafted text/);
    assert.equal((await loadEvalGatePage(PROJECT, drafted.id, drafted, db)).blocked, null);
  } finally {
    await client.close();
  }
});
