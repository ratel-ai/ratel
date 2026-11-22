import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { countClosedTurns } from "@/lib/ledger/closed-turns";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { type BuildJobDeps, buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import {
  closeIdleTraceTurns,
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadModelOnlyTraces } from "@/lib/readings/topics/queries";
import { loadRecentAskGroups } from "@/lib/readings/trace-signals/workflows/decide-queries";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import { listSessionList } from "@/lib/synthesis/traces/v2/sessions-list";
import { getSessionsAggregate } from "@/lib/synthesis/traces-sessions/tab-aggregates";
import { loadLedgerFacts } from "@/lib/views/health/ledger-facts-query";
import { healthPageState } from "@/lib/views/health/page-state";

/**
 * RC-742, end to end on a real schema: Ratel Cloud's own backend job exports
 * an `invoke_agent` root with its ask and `chat` children, no tool span. With
 * `cloud-tool-run-insights` on, ingest stores an `agent_run` row and the build
 * makes exactly one turn whose ask is the root's ask. Its `chat` children are
 * typed model-call steps of that turn (RC-1067).
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE = "a".repeat(32);
const ASK = "label_workflows for project p-1";
const T0 = Date.now() - 2 * 3_600_000;

type Db = ReturnType<typeof getDb>;

const messages = (text: string) =>
  JSON.stringify([{ role: "user", parts: [{ type: "text", content: text }] }]);

function span(overrides: Partial<DecodedSpan>): DecodedSpan {
  return {
    traceId: TRACE,
    spanId: "1".repeat(16),
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: T0,
    endUnixMs: T0 + 4_000,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "ratel-cloud" },
    scopeName: "ratel-cloud/model-calls",
    ...overrides,
  };
}

const chat = (n: number) =>
  span({
    spanId: String(n + 1).repeat(16),
    parentSpanId: "1".repeat(16),
    name: "chat claude-sonnet-5-5",
    kind: 3,
    startUnixMs: T0 + n * 1_000,
    endUnixMs: T0 + n * 1_000 + 800,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.input.messages": messages(`Name this workflow, part ${n}`),
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
    },
  });

const root = span({
  name: "invoke_agent label_workflows",
  attributes: {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "label_workflows",
    "gen_ai.conversation.id": "job-1",
    "gen_ai.input.messages": messages(ASK),
  },
});

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Ratel', 'ratel');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Ratel - prod', 'prod');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

/** `storeSpans` writes the span rows too and rolls the trace up, as the periodic sweep does (the Sessions list reads a run's error from the rollup). */
function ingestDeps(db: Db, storeSpans = false): PersistSpansDeps {
  return {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => rows.length,
    insertTraceEvents: (projectId: string, rows: Parameters<typeof insertTraceEvents>[1]) =>
      insertTraceEvents(projectId, rows, db),
    insertOtelSpans: storeSpans
      ? (
          projectId: string,
          rows: Parameters<typeof insertOtelSpans>[1],
          _db: unknown,
          options?: Parameters<typeof insertOtelSpans>[3],
        ) => insertOtelSpans(projectId, rows, db, options)
      : async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentSpanDedupe: null,
    logError: () => {},
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
}

/** Builds run 31 minutes after ingest: a quiet turn closes as `idle` (rule 5), like every OTLP turn. */
function buildDeps(db: Db, afterMs = 31 * 60_000): Partial<BuildJobDeps> {
  return {
    now: () => new Date(Date.now() + afterMs),
    getCursor: (p) => getTraceTurnsCursor(p, db),
    listEvents: (p, since, _db, limit, types) => listTurnEventsPage(p, since, db, limit, types),
    listHits: (ids) => listTurnEventHits(ids, db),
    loadTurns: (p, sessions, keys, reach) => loadReloadableTurns(p, sessions, keys, reach, db),
    writePage: (input) => writeTurnPage(input, db),
    closeIdle: (p, before, now) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: async () => null,
    enqueueReading: async () => null,
    onBacklogDrained: async () => null,
    onBacklogProgress: async () => null,
    observability: { trackSystemEvent: async () => {} },
    salt: "test-salt",
  };
}

/** The children arrive first, the root (which ends last) in a later export. */
async function ingestRun(db: Db, rootSpan: DecodedSpan = root, storeSpans = false): Promise<void> {
  const deps = ingestDeps(db, storeSpans);
  const context = { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" };
  assert.ok((await persistDecodedSpans([chat(1), chat(2)], context, deps)).ok);
  assert.ok((await persistDecodedSpans([rootSpan], context, deps)).ok);
  if (storeSpans)
    await refreshTraceSummaries(
      { visibilityLagMs: 0 },
      db as unknown as NonNullable<Parameters<typeof refreshTraceSummaries>[1]>,
    );
}

/** The Sessions list six minutes after ingest: past the 5-minute Active window, far inside the 30-minute idle window. */
async function sessionRows(db: Db) {
  const page = await listSessionList(
    PROJECT_ID,
    { filter: "all", now: new Date(Date.now() + 6 * 60_000) },
    db,
  );
  return page.items.map((item) => ({
    id: item.id,
    status: item.status,
    turns: item.turns,
    durationMs: item.durationMs,
  }));
}

async function turnsOf(db: Db) {
  return db.select().from(traceTurns);
}

/** The Agent health page state with no reading yet: what decides "No runs yet". */
async function healthKind(db: Db): Promise<string> {
  const ledger = await loadLedgerFacts(
    PROJECT_ID,
    { now: new Date(Date.now() + 31 * 60_000), windowDays: 7 },
    db,
  );
  return healthPageState({
    windowDays: 7,
    readingTurns: 0,
    floor: 50,
    ledger,
    imports: [],
    planWindowDays: 90,
  }).kind;
}

const window = () => ({ from: new Date(T0 - 3_600_000), to: new Date(Date.now() + 3_600_000) });

test("an invoke_agent run with chat children is exactly one closed turn, its ask the root's", async () => {
  const db = await setup();
  await ingestRun(db);
  const result = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
  assert.equal(result.outcome, "built");

  const turns = await turnsOf(db);
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.turnKey, `otlp:${TRACE}`);
  assert.equal(turn.sessionId, "job-1");
  assert.equal(turn.status, "closed");
  assert.equal(turn.invokeCount, 0);
  assert.equal(await countClosedTurns(PROJECT_ID, window().from, window().to, db), 1);
  // RC-747: the agent step names its agent, so Tasks can group runs by it.
  // Typed steps (RC-1067): each chat child is a model call after the user message it answers.
  const steps = await db.select().from(traceTurnSteps).orderBy(traceTurnSteps.ordinal);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.targetType, step.targetId]),
    [
      ["agent", null, "label_workflows"],
      ["user_message", null, null],
      ["model_call", null, "claude-sonnet-5-5"],
      ["user_message", null, null],
      ["model_call", null, "claude-sonnet-5-5"],
    ],
  );
  // The decision step reads the run's model call as its one step, both chats folded into it.
  const groups = await loadRecentAskGroups(PROJECT_ID, window().from, 10, db);
  assert.deepEqual(
    groups.map((group) => group.turns.map((t) => t.tools)),
    [[["model:claude-sonnet-5-5"]]],
  );

  const asks = await loadAskSourcesByTurn(PROJECT_ID, [turn.id], db);
  assert.deepEqual(asks.get(turn.id), { text: ASK, source: "prompt" });
  assert.equal(await healthKind(db), "too_few");
  // Intents reads the run as a turn, not again as a model-only trace.
  assert.deepEqual(await loadModelOnlyTraces(PROJECT_ID, window(), new Date(), 10, db), []);
});

test("a finished run reads Completed with its real duration in the Sessions list and its summary, minutes after it ended (RC-812)", async () => {
  const db = await setup();
  await ingestRun(db);
  // The build runs seconds after ingest, as the ingest-triggered job does.
  await buildProjectTraceTurns(PROJECT_ID, buildDeps(db, 10_000));

  const turn = (await turnsOf(db))[0]!;
  assert.equal(turn.status, "closed");
  assert.equal(turn.endedAt.getTime() - turn.startedAt.getTime(), 4_000);
  assert.deepEqual(await sessionRows(db), [
    { id: "job-1", status: "completed", turns: 1, durationMs: 4_000 },
  ]);

  const summary = await getSessionsAggregate(
    PROJECT_ID,
    { since: new Date(T0 - 3_600_000), until: new Date(Date.now() + 3_600_000) },
    db,
  );
  assert.equal(summary.count, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.p50DurationMs, 4_000);
});

test("a run whose root span ended in an error reads Failed, minutes after it ended (RC-812)", async () => {
  const db = await setup();
  await ingestRun(
    db,
    { ...root, statusCode: 2, attributes: { ...root.attributes, "error.type": "TimeoutError" } },
    true,
  );
  await buildProjectTraceTurns(PROJECT_ID, buildDeps(db, 10_000));
  assert.deepEqual(await sessionRows(db), [
    { id: "job-1", status: "failed", turns: 1, durationMs: 4_000 },
  ]);
});

test("two runs with their own conversations stay two sessions, each turn in its own", async () => {
  const db = await setup();
  await ingestRun(db);
  const other = "b".repeat(32);
  const context = { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" };
  const otherRoot = {
    ...root,
    traceId: other,
    spanId: "9".repeat(16),
    attributes: { ...root.attributes, "gen_ai.conversation.id": "job-2" },
  };
  const otherChat = {
    ...chat(1),
    traceId: other,
    spanId: "8".repeat(16),
    parentSpanId: otherRoot.spanId,
  };
  assert.ok((await persistDecodedSpans([otherChat, otherRoot], context, ingestDeps(db))).ok);
  await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
  const turns = await turnsOf(db);
  assert.deepEqual(turns.map((turn) => [turn.turnKey, turn.sessionId]).sort(), [
    [`otlp:${TRACE}`, "job-1"],
    [`otlp:${other}`, "job-2"],
  ]);
});

test("a bare chat span with no invoke_agent root is one closed turn of its model call", async () => {
  const db = await setup();
  const context = { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" };
  const bare = { ...chat(1), parentSpanId: null };
  assert.ok((await persistDecodedSpans([bare], context, ingestDeps(db))).ok);
  await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
  // Typed steps (RC-1067): a model call is a step, so its trace is a turn with no agent step.
  const turns = await turnsOf(db);
  assert.deepEqual(
    turns.map((turn) => [turn.turnKey, turn.status]),
    [[`otlp:${bare.traceId}`, "closed"]],
  );
  const steps = await db.select().from(traceTurnSteps).orderBy(traceTurnSteps.ordinal);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.targetId]),
    [
      ["user_message", null],
      ["model_call", "claude-sonnet-5-5"],
    ],
  );
});
