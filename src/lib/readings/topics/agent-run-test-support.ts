import { drizzle } from "drizzle-orm/pglite";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { listClosedTurnsPage } from "@/lib/ledger/closed-turns";
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
import { type AssignTopicsResult, assignProjectTopics } from "@/lib/readings/topics/job";
import {
  loadHelperTools,
  loadModelOnlyTraces,
  loadPreviousPlacements,
  loadRefusedTraces,
  loadSelfCorrectionKinds,
  loadStoredTopics,
  loadTopicReading,
  loadTurnTasks,
  readingStart,
  saveTopicReading,
} from "@/lib/readings/topics/queries";
import {
  loadCarriedVerdicts,
  loadVerdicts,
  saveVerdicts,
} from "@/lib/readings/trace-signals/workflows/decide-queries";
import {
  loadAskSourcesByTurn,
  loadWorkflowLabels,
} from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * Agent runs end to end on PGlite, for the Intents tests: Ratel Cloud's own
 * backend jobs as they export (an `invoke_agent` root with the job's ask and
 * one `chat` child, no tool span), through OTLP ingest, the turn build and
 * the `assign_topics` reading. No model is called: asks are placed by wording.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
/** The project the jobs ran for: a made-up id, as the job's ask carries one. */
const JOB_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const MINUTE = 60_000;
const STATUS_ERROR = 2;

type Db = ReturnType<typeof getDb>;

export interface AgentRunDb {
  db: Db;
  projectId: string;
}

/** One backend job run. */
export interface AgentRun {
  /** The job kind: the agent's name and the first word of its ask. */
  agent: string;
  /** The root's `error.type`, when the run failed with a named error. */
  errorType?: string;
  /** The root's status code; 2 is an error. */
  statusCode?: number;
}

/** A migrated database with one organization and project. */
export async function setupAgentRunDb(): Promise<AgentRunDb> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Ratel', 'ratel');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Ratel - prod', 'prod');
  `);
  return { db: drizzle(client, { schema }) as unknown as Db, projectId: PROJECT_ID };
}

/** Ingests the runs, two hours ago and a minute apart, then builds their turns (closed as idle). */
export async function ingestRuns({ db }: AgentRunDb, runs: readonly AgentRun[]): Promise<void> {
  const context = { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" };
  const t0 = Date.now() - 120 * MINUTE;
  for (const [index, run] of runs.entries()) {
    const result = await persistDecodedSpans(
      runSpans(run, index, t0 + index * MINUTE),
      context,
      ingestDeps(db),
    );
    if (!result.ok) throw new Error(`ingest failed for run ${index}`);
  }
  await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
}

/** One `assign_topics` reading, with `cloud-tool-run-insights` on or off. */
export async function readIntents(
  { db }: AgentRunDb,
  toolRuns: boolean,
): Promise<AssignTopicsResult> {
  return assignProjectTopics(PROJECT_ID, {
    now: () => new Date(Date.now() + 31 * MINUTE),
    readingStart: (p, w, max) => readingStart(p, w, max, db),
    listPage: (p, range, _db, limit) => listClosedTurnsPage(p, range, db, limit),
    loadAsks: (p, ids) => loadAskSourcesByTurn(p, ids, db),
    loadModelOnlyTraces: (p, w, closed, max) => loadModelOnlyTraces(p, w, closed, max, db),
    loadRefusedTraces: (p, ids) => loadRefusedTraces(p, ids, db),
    idleCloseMs: 30 * MINUTE,
    hashSalt: "test-salt",
    loadTurnTasks: (p, ids) => loadTurnTasks(p, ids, db),
    loadHelperTools: (p) => loadHelperTools(p, db),
    loadSelfCorrections: (p, ids) => loadSelfCorrectionKinds(p, ids, db),
    loadTopics: (p) => loadStoredTopics(p, db),
    loadPreviousPlacements: (p, ids) => loadPreviousPlacements(p, ids, db),
    loadReading: (p) => loadTopicReading(p, db),
    loadVerdicts: (p, hash, hashes) => loadVerdicts(p, hash, hashes, db),
    saveVerdicts: (p, hash, model, rows) => saveVerdicts(p, hash, model, rows, db),
    saveReading: (p, reading) => saveTopicReading(p, reading, db),
    loadCarried: (p, hashes) => loadCarriedVerdicts(p, hashes, db),
    toolRunInsights: async () => toolRuns,
    loadTaskLabels: (p) => loadWorkflowLabels(p, db),
    judge: null,
    sentimentJudge: null,
    name: null,
    nameModel: "test-model",
    observability: { trackSystemEvent: async () => undefined },
  });
}

/** The run's spans as the job exports them: the root with the ask, and one model call under it. */
function runSpans(run: AgentRun, index: number, startMs: number): DecodedSpan[] {
  const traceId = (index + 1).toString(16).padStart(32, "0");
  const rootId = (index + 1).toString(16).padStart(16, "a");
  const base = {
    traceId,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "ratel-cloud" },
    scopeName: "ratel-cloud/model-calls",
  };
  const root: DecodedSpan = {
    ...base,
    spanId: rootId,
    parentSpanId: null,
    name: `invoke_agent ${run.agent}`,
    kind: 1,
    startUnixMs: startMs,
    endUnixMs: startMs + 4_000,
    statusCode: run.statusCode ?? (run.errorType ? STATUS_ERROR : 0),
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": run.agent,
      "gen_ai.conversation.id": `job-${index}`,
      "gen_ai.input.messages": JSON.stringify([
        {
          role: "user",
          parts: [{ type: "text", content: `${run.agent} for project ${JOB_PROJECT_ID}\n{}` }],
        },
      ]),
      ...(run.errorType ? { "error.type": run.errorType } : {}),
    },
  };
  const chat: DecodedSpan = {
    ...base,
    spanId: (index + 1).toString(16).padStart(16, "c"),
    parentSpanId: rootId,
    name: "chat claude-sonnet-5-5",
    kind: 3,
    startUnixMs: startMs + 1_000,
    endUnixMs: startMs + 3_000,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
    },
  };
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
    agentSpanDedupe: null,
    logError: () => {},
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
}

/** The build runs 31 minutes from now: a quiet turn closes as idle, like every OTLP turn. */
function buildDeps(db: Db): Partial<BuildJobDeps> {
  return {
    now: () => new Date(Date.now() + 31 * MINUTE),
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
