import assert from "node:assert/strict";
import { test } from "node:test";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { type BuildJobDeps, buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import {
  closeIdleTraceTurns,
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { TOOL_RUN_MINING } from "@/lib/readings/trace-signals/tool-run-insights";
import { buildTaskList, type TaskListModel } from "@/lib/views/tasks/model";
import { loadLatestTasksRun } from "@/lib/views/tasks/queries";

/**
 * RC-805, the shape of Ratel's own prod project: seven closed agent runs of
 * Ratel's own backend jobs (three `label_workflows`, three
 * `assign_topics`, one `cluster_intents`), model calls only, no tool span.
 * Ingest, the turn build, the signal job and the Tasks model run as in
 * production, on a real schema. With `cloud-tool-run-insights` on, Tasks
 * reads one task per agent with three runs; off, it reads as before.
 */

const AGENTS = [
  "label_workflows",
  "assign_topics",
  "label_workflows",
  "assign_topics",
  "label_workflows",
  "assign_topics",
  "cluster_intents",
];
const T0 = Date.now() - 2 * 3_600_000;
/** After the 30 minute idle close of every run. */
const LATER = new Date(Date.now() + 31 * 60_000);

const hex = (n: number, length: number) => (n + 1).toString(16).padStart(length, "0");
const messages = (text: string) =>
  JSON.stringify([{ role: "user", parts: [{ type: "text", content: text }] }]);

function span(run: number, overrides: Partial<DecodedSpan>): DecodedSpan {
  const start = T0 + run * 60_000;
  return {
    traceId: hex(run, 32),
    spanId: hex(run * 16, 16),
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: start,
    endUnixMs: start + 4_000,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "ratel-cloud" },
    scopeName: "ratel-cloud/model-calls",
    ...overrides,
  };
}

/** One backend job: an `invoke_agent` root with one `chat` child, the child exported first. */
function agentRun(run: number, agent: string): [DecodedSpan, DecodedSpan] {
  const chat = span(run, {
    spanId: hex(run * 16 + 1, 16),
    parentSpanId: hex(run * 16, 16),
    name: "chat claude-sonnet-5-5",
    kind: 3,
    endUnixMs: T0 + run * 60_000 + 800,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.input.messages": messages(`${agent}, part 1`),
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
    },
  });
  const root = span(run, {
    name: `invoke_agent ${agent}`,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": agent,
      "gen_ai.conversation.id": `job-${run}`,
      "gen_ai.input.messages": messages(`${agent} for a project`),
    },
  });
  return [chat, root];
}

function ingestDeps(db: Db): PersistSpansDeps {
  return {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => rows.length,
    insertTraceEvents: (projectId: string, rows: Parameters<typeof insertTraceEvents>[1]) =>
      insertTraceEvents(projectId, rows, db),
    insertOtelSpans: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentRunsEnabled: async () => true,
    agentSpanDedupe: null,
    logError: () => {},
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
}

function buildDeps(db: Db): Partial<BuildJobDeps> {
  return {
    now: () => LATER,
    readsAgentRuns: async () => true,
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

/** The Tasks list after ingest, the turn build and one signal run, as `list_tasks` reads it. */
async function tasksAfterReading(flag: boolean): Promise<TaskListModel> {
  const { db } = await setupDb();
  const context = { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" };
  for (const [run, agent] of AGENTS.entries()) {
    const [chat, root] = agentRun(run, agent);
    assert.ok((await persistDecodedSpans([chat], context, ingestDeps(db))).ok);
    assert.ok((await persistDecodedSpans([root], context, ingestDeps(db))).ok);
  }
  assert.equal((await buildProjectTraceTurns(PROJECT_ID, buildDeps(db))).outcome, "built");
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, new Date(LATER.getTime() + 60_000), [], {
      workflowMining: async () => (flag ? TOOL_RUN_MINING : null),
    }),
  );
  assert.equal(result.outcome, "completed");
  assert.equal(result.turnsScanned, 7);
  const run = await loadLatestTasksRun(PROJECT_ID, db);
  assert.ok(run);
  return buildTaskList({
    projectId: PROJECT_ID,
    run: { windowDays: run.windowDays, finishedAt: run.finishedAt, turnsScanned: run.turnsScanned },
    stored: run.workflows,
    labels: new Map(),
    names: new Map(),
    issues: [],
    insights: null,
    fixes: [],
    recorded: null,
    topics: null,
    price: null,
  });
}

test("flag on: a project of agent runs alone reads one task per agent with three runs", async () => {
  const list = await tasksAfterReading(true);
  assert.equal(list.state, "ready");
  assert.deepEqual(list.rows.map((row) => [row.name, row.runs]).sort(), [
    ["Assign topics", 3],
    ["Label workflows", 3],
  ]);
  assert.equal(list.stats.allRuns, 7);
  assert.equal(list.stats.runsInTasks, 6);
});

test("flag off: the same project stores no task reading, as before", async () => {
  const list = await tasksAfterReading(false);
  assert.equal(list.state, "blocked");
  assert.equal(list.blocked, "no_tool_calls");
  assert.equal(list.rows.length, 0);
});
