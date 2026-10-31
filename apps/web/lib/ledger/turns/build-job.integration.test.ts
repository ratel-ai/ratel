import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { countClosedTurns } from "../closed-turns";
import type { RunTrigger } from "../run-trigger";
import {
  type BuildJobDeps,
  buildProjectTraceTurns,
  createMissingSaltReporter,
  enqueueDueTraceTurnBuilds,
} from "./build-job";
import {
  closeIdleTraceTurns,
  enqueueBuildTraceTurnsJob,
  getTraceTurnsCursor,
  listProjectsDueTraceTurnBuild,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  parseBuildJobRequest,
  writeTurnPage,
} from "./queries";

/**
 * The build job against real PGlite. Owned (ADR-0030): the signal-run enqueues the
 * readings supply are stand-ins here (a coalesced `compute_trace_signals` insert and a
 * recorded callback), so the test proves the seams without importing L4.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  // PGlite and node-postgres expose the same query surface; cast once here.
  return { client, db: drizzle(client) as unknown as Db };
}

let seq = 0;
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    v: 2,
    ts: Date.now() - 60 * MINUTE + seq * 1_000,
    session_id: "sess-a",
    source_id: "acme-app",
    event_id: `evt-${seq}`,
    end_user_id: "alice@example.com",
    ...body,
  };
}

function search(query: string, hits: string[], over: Record<string, unknown> = {}) {
  return envelope({
    type: "search",
    query,
    origin: "agent",
    top_k: hits.length,
    hits: hits.map((tool_id, i) => ({ tool_id, score: 1 - i / 10 })),
    ...over,
  });
}

function invocation(tool: string, over: Record<string, unknown> = {}) {
  return [
    envelope({ type: "invoke_start", tool_id: tool, invocation_id: `inv-${seq + 1}`, ...over }),
    envelope({
      type: "invoke_end",
      tool_id: tool,
      invocation_id: `inv-${seq}`,
      took_ms: 40,
      ...over,
    }),
  ];
}

async function ingest(db: Db, events: Record<string, unknown>[]): Promise<void> {
  const { valid, rejected } = parseTraceEvents(events);
  assert.deepEqual(rejected, []);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" as const })),
    db,
  );
  // Each ingest is its own transaction; keep receipt times apart.
  await new Promise((r) => setTimeout(r, 5));
}

/** The stand-in for the readings' signal-run enqueue: coalesced by the jobs index. */
async function enqueueComputeJob(
  projectId: string,
  trigger: RunTrigger,
  db: Db,
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: "compute_trace_signals", status: "queued", payload: { trigger } })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

interface Tracked {
  event: string;
  properties: Record<string, unknown>;
}

function deps(
  db: Db,
  tracked: Tracked[] = [],
  over: Partial<BuildJobDeps> = {},
): Partial<BuildJobDeps> {
  return {
    getCursor: (p) => getTraceTurnsCursor(p, db),
    listEvents: (p, since, _db, limit) => listTurnEventsPage(p, since, db, limit),
    listHits: (ids) => listTurnEventHits(ids, db),
    loadTurns: (p, sessions, keys, reach) => loadReloadableTurns(p, sessions, keys, reach, db),
    writePage: (input) => writeTurnPage(input, db),
    closeIdle: (p, before, now) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: (p, request) => enqueueBuildTraceTurnsJob(p, db, request),
    enqueueReading: (p, trigger) => enqueueComputeJob(p, trigger, db),
    observability: {
      trackSystemEvent: async (event, _distinctId, properties) => {
        tracked.push({ event, properties });
      },
    },
    salt: "test-salt",
    ...over,
  };
}

async function count(client: PGlite, sql: string): Promise<number> {
  const result = await client.query<{ n: number }>(sql);
  return result.rows[0]?.n ?? 0;
}

async function maxReceived(client: PGlite): Promise<string> {
  const result = await client.query<{ t: string }>(
    `select max(received_at)::text as t from trace_events where project_id = '${PROJECT_ID}'`,
  );
  return result.rows[0]?.t ?? "";
}

test("the first build seeds from the window and sets the cursor to the last received_at", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    search("why is the build broken", ["gh_run_list", "gh_pr_view"]),
    ...invocation("gh_pr_view"),
  ]);
  await ingest(db, [search("send the weekly report", ["send_email"], { session_id: "sess-b" })]);
  const tracked: Tracked[] = [];

  const result = await buildProjectTraceTurns(PROJECT_ID, deps(db, tracked));

  assert.equal(result.outcome, "built");
  assert.equal(result.firstBuild, true);
  assert.equal(result.events, 4);
  assert.equal(result.turnsWritten, 2);
  assert.equal(result.stepsWritten, 3);
  assert.equal((await getTraceTurnsCursor(PROJECT_ID, db))?.raw, await maxReceived(client));
  const turn = await client.query<{
    search_count: number;
    invoke_count: number;
    first_try: boolean;
    status: string;
  }>(
    `select search_count, invoke_count, first_try, status from trace_turns where session_id = 'sess-a'`,
  );
  assert.deepEqual(turn.rows, [
    { search_count: 1, invoke_count: 1, first_try: true, status: "open" },
  ]);
  const built = tracked.find((t) => t.event === "trace_turns_built");
  assert.equal(built?.properties.turns_written, 2);
  assert.equal(built?.properties.object_action, "trace_turns_built");
});

test("a rerun with nothing new is a no-op that leaves turns and cursor alone", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    search("why is the build broken", ["gh_run_list"]),
    ...invocation("gh_run_list"),
  ]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));
  const cursor = await getTraceTurnsCursor(PROJECT_ID, db);
  const before = await client.query(`select * from trace_turns order by id`);

  const second = await buildProjectTraceTurns(PROJECT_ID, deps(db));

  assert.equal(second.outcome, "caught_up");
  assert.equal(second.pages, 0);
  assert.deepEqual(await getTraceTurnsCursor(PROJECT_ID, db), cursor);
  assert.deepEqual((await client.query(`select * from trace_turns order by id`)).rows, before.rows);
});

test("a search and its invocation in two ingest batches attribute to one turn", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("assign the task", ["find_task", "assign_task", "create_task"])]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));
  await ingest(db, invocation("assign_task"));

  const second = await buildProjectTraceTurns(PROJECT_ID, deps(db));

  assert.equal(second.turnsWritten, 1);
  assert.equal(await count(client, `select count(*)::int as n from trace_turns`), 1);
  const steps = await client.query<{
    kind: string;
    offered_rank: number | null;
    first_search_rank: number | null;
    outcome: string | null;
  }>(
    `select kind, offered_rank, first_search_rank, outcome from trace_turn_steps order by ordinal`,
  );
  assert.deepEqual(steps.rows, [
    { kind: "search", offered_rank: null, first_search_rank: null, outcome: null },
    { kind: "invoke", offered_rank: 2, first_search_rank: 2, outcome: "ok" },
  ]);
});

test("an end on a later page pairs into its start's turn after a gap closed it", async () => {
  const { client, db } = await setup();
  const t0 = Date.now() - 30 * MINUTE;
  await ingest(db, [
    search("assign the task", ["find_task", "assign_task"], { ts: t0 }),
    envelope({ type: "invoke_start", tool_id: "assign_task", ts: t0 + 1_000 }),
  ]);
  await ingest(db, [search("send the weekly report", ["send_email"], { ts: t0 + 200_000 })]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));
  await ingest(db, [
    envelope({ type: "invoke_end", tool_id: "assign_task", took_ms: 40, ts: t0 + 201_000 }),
  ]);

  await buildProjectTraceTurns(PROJECT_ID, deps(db));

  const steps = await client.query<{
    turn: number;
    kind: string;
    target_id: string | null;
    outcome: string | null;
  }>(
    `select dense_rank() over (order by t.started_at)::int as turn, s.kind, s.target_id, s.outcome
       from trace_turn_steps s join trace_turns t on t.id = s.turn_id
      order by t.started_at, s.ordinal`,
  );
  assert.deepEqual(steps.rows, [
    { turn: 1, kind: "search", target_id: null, outcome: null },
    { turn: 1, kind: "invoke", target_id: "assign_task", outcome: "ok" },
    { turn: 2, kind: "search", target_id: null, outcome: null },
  ]);
  const turns = await client.query<{ ended_by: string | null; invoke_count: number }>(
    `select ended_by, invoke_count from trace_turns order by started_at`,
  );
  assert.deepEqual(turns.rows, [
    { ended_by: "gap", invoke_count: 1 },
    { ended_by: null, invoke_count: 0 },
  ]);
});

test("a declared turn id from the envelope keys the turn", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    search("q", ["a"], { turn_id: "turn-7" }),
    ...invocation("a", { turn_id: "turn-7" }),
  ]);

  await buildProjectTraceTurns(PROJECT_ID, deps(db));

  const turns = await client.query<{ turn_key: string; turn_source: string }>(
    `select turn_key, turn_source from trace_turns`,
  );
  assert.deepEqual(turns.rows, [{ turn_key: "declared:turn-7", turn_source: "declared" }]);
});

test("the ledger stores no query text and no raw end-user id", async () => {
  const { client, db } = await setup();
  await ingest(db, [
    search("reset the password for bob", ["reset_password"]),
    ...invocation("reset_password"),
  ]);

  await buildProjectTraceTurns(PROJECT_ID, deps(db));

  const dump = JSON.stringify([
    (await client.query(`select * from trace_turns`)).rows,
    (await client.query(`select * from trace_turn_steps`)).rows,
  ]);
  assert.ok(!dump.includes("password for bob"));
  assert.ok(!dump.includes("alice@example.com"));
  assert.match(dump, /"end_user_key":"[0-9a-f]{32}"/);
});

test("pruning trace_events leaves the turn ledger intact", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("q", ["a", "b"]), ...invocation("b")]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));

  await client.exec(`delete from trace_events`);

  assert.equal(await count(client, `select count(*)::int as n from trace_turns`), 1);
  assert.equal(await count(client, `select count(*)::int as n from trace_turn_steps`), 2);
});

test("builds and signal runs coalesce to one queued job per project", async () => {
  const { client, db } = await setup();

  const first = await enqueueBuildTraceTurnsJob(PROJECT_ID, db);
  const second = await enqueueBuildTraceTurnsJob(PROJECT_ID, db);

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from jobs where kind = 'build_trace_turns' and status = 'queued'`,
    ),
    1,
  );
  await client.exec(
    `insert into jobs (project_id, kind, status) values ('${PROJECT_ID}', 'compute_trace_signals', 'queued')`,
  );
  await assert.rejects(
    client.exec(
      `insert into jobs (project_id, kind, status) values ('${PROJECT_ID}', 'compute_trace_signals', 'queued')`,
    ),
  );
  await client.exec(`update jobs set status = 'running' where kind = 'build_trace_turns'`);
  assert.ok(
    await enqueueBuildTraceTurnsJob(PROJECT_ID, db),
    "a running build does not block a follow-up",
  );
});

test("an open turn closes as idle once its session is quiet for 30 minutes", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));
  const later = new Date(Date.now() + 31 * MINUTE);

  const result = await buildProjectTraceTurns(PROJECT_ID, deps(db, [], { now: () => later }));

  assert.equal(result.idleClosed, 1);
  const turn = await client.query<{ status: string; ended_by: string }>(
    `select status, ended_by from trace_turns`,
  );
  assert.deepEqual(turn.rows, [{ status: "closed", ended_by: "idle" }]);
});

test("an import's runs close as soon as they are built, so the reading it asks for counts them", async () => {
  const { client, db } = await setup();
  // Imports arrive the way an OpenTelemetry export does: the OTLP lane, one trace per run.
  const otlp = async (events: Record<string, unknown>[]) => {
    const { valid, rejected } = parseTraceEvents(events);
    assert.deepEqual(rejected, []);
    await insertTraceEvents(
      PROJECT_ID,
      valid.map((e) => ({ ...e, ingestSource: "otlp" as const })),
      db,
    );
  };
  const imported = {
    source_id: "langfuse-import",
    session_id: "trace-imported",
    trace_id: "trace-imported",
  };
  await otlp(invocation("gh_run_list", imported));
  await otlp(
    invocation("send_email", {
      source_id: "work-assistant",
      session_id: "trace-live",
      trace_id: "trace-live",
    }),
  );

  await buildProjectTraceTurns(PROJECT_ID, deps(db));

  const turns = await client.query<{
    session_id: string;
    lane: string;
    status: string;
    ended_by: string | null;
  }>(`select session_id, lane, status, ended_by from trace_turns order by session_id`);
  assert.deepEqual(turns.rows, [
    { session_id: "trace-imported", lane: "otlp", status: "closed", ended_by: "idle" },
    { session_id: "trace-live", lane: "otlp", status: "open", ended_by: null },
  ]);
  assert.equal(
    await countClosedTurns(PROJECT_ID, new Date(0), new Date(Date.now() + MINUTE), db),
    1,
  );
});

test("a cursor behind the retention window logs the lost backlog and jumps", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);
  await client.exec(
    `update projects set trace_turns_built_through = now() - interval '40 days' where id = '${PROJECT_ID}'`,
  );
  const tracked: Tracked[] = [];

  const result = await buildProjectTraceTurns(PROJECT_ID, deps(db, tracked));

  assert.equal(result.backlogLost, true);
  assert.equal(result.firstBuild, false);
  assert.equal(result.events, 3, "events inside the window are still built");
  const lost = tracked.find((t) => t.event === "trace_turns_backlog_lost");
  assert.ok(lost);
  assert.ok((lost.properties.lag_ms as number) > 9 * 24 * 60 * MINUTE);
});

test("a run that caught up after writing or closing calls the backlog-drained seam once", async () => {
  const { db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);
  const drained: string[] = [];
  const seam = (p: string) => {
    drained.push(p);
    return Promise.resolve();
  };

  await buildProjectTraceTurns(PROJECT_ID, deps(db, [], { onBacklogDrained: seam }));
  assert.deepEqual(drained, [PROJECT_ID], "a page was built");

  await buildProjectTraceTurns(PROJECT_ID, deps(db, [], { onBacklogDrained: seam }));
  assert.deepEqual(drained, [PROJECT_ID], "nothing new: the seam is not called");

  const later = new Date(Date.now() + 31 * MINUTE);
  await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, [], { onBacklogDrained: seam, now: () => later }),
  );
  assert.deepEqual(drained, [PROJECT_ID, PROJECT_ID], "an idle close counts too");

  const without = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, [], { onBacklogDrained: undefined }),
  );
  assert.equal(without.outcome, "caught_up", "the seam is optional");
});

test("without a hash salt the build skips: nothing written, cursor untouched, reported", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);
  const reported: string[] = [];
  const tracked: Tracked[] = [];

  const result = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, tracked, { salt: null, reportMissingSalt: (p) => reported.push(p) }),
  );

  assert.equal(result.outcome, "salt_missing");
  assert.equal(result.events, 0);
  assert.deepEqual(reported, [PROJECT_ID]);
  assert.deepEqual(tracked, []);
  assert.equal(await count(client, `select count(*)::int as n from trace_turns`), 0);
  assert.equal(await count(client, `select count(*)::int as n from trace_turn_steps`), 0);
  assert.equal(await getTraceTurnsCursor(PROJECT_ID, db), null);

  const later = await buildProjectTraceTurns(PROJECT_ID, deps(db));
  assert.equal(later.outcome, "built", "the backlog builds once the salt is set");
  assert.equal(later.events, 3);
});

test("the missing-salt reporter reports once per process", () => {
  const calls: unknown[][] = [];
  const reportMissingSalt = createMissingSaltReporter((...args) => {
    calls.push(args);
  });

  reportMissingSalt("p1");
  reportMissingSalt("p2");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[1], "system:trace-turns");
  assert.deepEqual(calls[0]?.[2], { project_id: "p1", reason: "trace_signals_hash_salt_missing" });
});

test("a backlog larger than the page budget continues in a freshly enqueued job", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("a", ["t1"])]);
  await ingest(db, [search("b", ["t2"])]);
  await ingest(db, [search("c", ["t3"])]);

  const result = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, [], { pageLimit: 1, maxPages: 2 }),
  );

  assert.equal(result.pages, 2);
  assert.equal(result.continued, true);
  assert.equal(
    await count(
      client,
      `select count(*)::int as n from jobs where kind = 'build_trace_turns' and status = 'queued'`,
    ),
    1,
  );
  const rest = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, [], { pageLimit: 1, maxPages: 5 }),
  );
  assert.equal(rest.continued, false);
  assert.equal((await getTraceTurnsCursor(PROJECT_ID, db))?.raw, await maxReceived(client));
  assert.equal(
    await count(client, `select search_count::int as n from trace_turns`),
    3,
    "one inferred turn",
  );
});

async function queuedPayloads(client: PGlite, kind: string): Promise<unknown[]> {
  const result = await client.query<{ payload: unknown }>(
    `select payload from jobs where kind = '${kind}' and status = 'queued' order by created_at`,
  );
  return result.rows.map((r) => r.payload);
}

test("a build asked for a reading enqueues the run once it has caught up, and its follow-up carries the ask", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("a", ["t1"])]);
  await ingest(db, [search("b", ["t2"])]);
  await ingest(db, [search("c", ["t3"])]);
  const tracked: Tracked[] = [];

  // Half the backlog in: no run reads half of it; the follow-up build carries the ask.
  const half = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, tracked, { pageLimit: 1, maxPages: 2 }),
    { reading: "manual" },
  );
  assert.equal(half.continued, true);
  assert.equal(half.readingQueued, false);
  assert.deepEqual(await queuedPayloads(client, "compute_trace_signals"), []);
  const [follow] = await queuedPayloads(client, "build_trace_turns");
  assert.deepEqual(follow, { reading: "manual" });

  // The follow-up, as the job runner hands it over, catches up and asks for the run.
  await client.exec(`update jobs set status = 'running' where kind = 'build_trace_turns'`);
  const rest = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, tracked, { pageLimit: 1, maxPages: 5 }),
    parseBuildJobRequest(follow),
  );
  assert.equal(rest.continued, false);
  assert.equal(rest.readingQueued, true);
  assert.deepEqual(await queuedPayloads(client, "compute_trace_signals"), [{ trigger: "manual" }]);
  assert.deepEqual(
    tracked.filter((t) => t.event === "trace_turns_built").map((t) => t.properties.reading_queued),
    [false, true],
  );

  // Caught up with a run already queued: that run reads every turn, so nothing more is queued.
  const again = await buildProjectTraceTurns(PROJECT_ID, deps(db), { reading: "manual" });
  assert.equal(again.readingQueued, false);
  assert.equal(
    await count(client, `select count(*)::int as n from jobs where kind = 'compute_trace_signals'`),
    1,
  );

  // A build nobody asked a reading of queues none.
  await client.exec(`delete from jobs where kind = 'compute_trace_signals'`);
  const plain = await buildProjectTraceTurns(PROJECT_ID, deps(db));
  assert.equal(plain.readingQueued, false);
  assert.deepEqual(await queuedPayloads(client, "compute_trace_signals"), []);

  // Without the readings' seam, an ask is acknowledged as not queued rather than failing.
  const unwired = await buildProjectTraceTurns(
    PROJECT_ID,
    deps(db, [], { enqueueReading: undefined }),
    {
      reading: "manual",
    },
  );
  assert.equal(unwired.readingQueued, false);
});

test("an ask for a reading is never dropped: it merges into the build already queued", async () => {
  const { client, db } = await setup();

  const plain = await enqueueBuildTraceTurnsJob(PROJECT_ID, db);
  assert.ok(plain);
  const asked = await enqueueBuildTraceTurnsJob(PROJECT_ID, db, { reading: "manual" });
  assert.equal(asked?.id, plain.id, "the queued build is the one that asks");
  assert.deepEqual(await queuedPayloads(client, "build_trace_turns"), [{ reading: "manual" }]);
  assert.equal(
    await enqueueBuildTraceTurnsJob(PROJECT_ID, db),
    null,
    "a plain enqueue still coalesces",
  );
  assert.deepEqual(
    await queuedPayloads(client, "build_trace_turns"),
    [{ reading: "manual" }],
    "and leaves the ask alone",
  );

  // A running build has read its payload already: the ask queues a build of its own.
  await client.exec(`update jobs set status = 'running' where kind = 'build_trace_turns'`);
  const next = await enqueueBuildTraceTurnsJob(PROJECT_ID, db, { reading: "manual" });
  assert.ok(next);
  assert.notEqual(next.id, plain.id);
  assert.deepEqual(await queuedPayloads(client, "build_trace_turns"), [{ reading: "manual" }]);
});

test("a build job's payload names the reading it asks for, or none", () => {
  assert.deepEqual(parseBuildJobRequest({ reading: "manual" }), { reading: "manual" });
  assert.deepEqual(parseBuildJobRequest({ reading: "first_build", other: 1 }), {
    reading: "first_build",
  });
  for (const payload of [null, undefined, "manual", {}, { reading: "soon" }, { reading: 1 }]) {
    assert.deepEqual(parseBuildJobRequest(payload), {}, JSON.stringify(payload) ?? "undefined");
  }
});

test("the cron safety net finds projects with unbuilt events or idle open turns", async () => {
  const { db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);

  assert.deepEqual(await listProjectsDueTraceTurnBuild(db), [{ id: PROJECT_ID }]);
  const due = await enqueueDueTraceTurnBuilds({
    enqueueBuild: (p) => enqueueBuildTraceTurnsJob(p, db),
    listDueProjects: () => listProjectsDueTraceTurnBuild(db),
  });
  assert.equal(due.enqueued, 1);
  assert.deepEqual(
    await listProjectsDueTraceTurnBuild(db),
    [],
    "a queued build is not enqueued again",
  );
});

test("after a build only idle open turns make a project due again", async () => {
  const { client, db } = await setup();
  await ingest(db, [search("q", ["a"]), ...invocation("a")]);
  await buildProjectTraceTurns(PROJECT_ID, deps(db));
  await client.exec(`delete from jobs`);

  assert.deepEqual(await listProjectsDueTraceTurnBuild(db), []);
  assert.deepEqual(
    await listProjectsDueTraceTurnBuild(db, { now: new Date(Date.now() + 31 * MINUTE) }),
    [{ id: PROJECT_ID }],
  );
});
