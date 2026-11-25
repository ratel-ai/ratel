import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { SettledDelivery } from "@/lib/contracts/ingest-queue";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import type { ProcessTracesDeps } from "@/lib/ingest/otlp/process-traces";
import { processTraces } from "@/lib/ingest/otlp/process-traces";
import {
  findStoredOtelSpans,
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { createGenAiLogStore } from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import type { AcceptDeps } from "@/lib/ingest/queue/accept";
import type { EnvelopeHandler, EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import type { RetryPolicy } from "@/lib/ingest/queue/port/settle";
import { createPostgresQueue } from "@/lib/ingest/queue/postgres/postgres-queue";
import { createEnvelopeHandler } from "@/lib/ingest/queue/process";
import { createQuotaGate } from "@/lib/ingest/queue/quota-gate";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import type { getDb } from "@/lib/platform/db/client";
import * as tables from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { touchApiKeyAt } from "@/lib/platform/projects/queries";
import { apiKeys } from "@/lib/platform/projects/schema";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import { enqueueFoldIntentGraphJob } from "@/lib/readings/intent-graph/queries";

/** A deployment over PGlite, in direct mode and with a queue, for the queued-ingest tests. */

export const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const SECRET_KEY_ID = "33333333-3333-4333-8333-333333333333";
export const SHARED_KEY_ID = "44444444-4444-4444-8444-444444444444";
export const SECRET_KEY = "rtl_secret";
/** A publishable key: append only, with shared limits. */
export const SHARED_KEY = "rtl_shared";

export type Db = ReturnType<typeof getDb>;
export type Usage = Map<string, number>;

const ORGANIZATION = { id: ORGANIZATION_ID, name: "Acme", slug: "acme" };
const FAST_POLICY: RetryPolicy = {
  waitsMs: [5, 5, 5, 5],
  outageWaitMs: { first: 5, max: 20 },
};

export interface Deployment {
  client: PGlite;
  db: Db;
  /** What the edition's counter holds, per organization. */
  usage: Usage;
  logs: { message: string; fields?: Record<string, unknown> }[];
}

export async function setupDeployment(): Promise<Deployment> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into api_keys (id, project_id, key_hash, key_prefix, scopes) values
      ('${SECRET_KEY_ID}', '${PROJECT_ID}', 'hashed:${SECRET_KEY}', 'rtl_s', '{*}'),
      ('${SHARED_KEY_ID}', '${PROJECT_ID}', 'hashed:${SHARED_KEY}', 'rtl_p',
       '{ingest:traces,ingest:logs,ingest:events}');
  `);
  const db = drizzle(client, { schema: tables }) as unknown as Db;
  return { client, db, usage: new Map(), logs: [] };
}

const silent = { logWarn: () => undefined, shouldSampleSuccess: () => false };

/** What a trace store needs, the same in both modes. */
function storeDeps({ db, usage }: Deployment) {
  return {
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertTraceEvents: (projectId, events, _db, options) =>
      insertTraceEvents(projectId, events, db, options),
    insertOtelSpans: (projectId, rows, _db, options) =>
      insertOtelSpans(projectId, rows, db, options),
    findStoredOtelSpans: (projectId, spans) => findStoredOtelSpans(projectId, spans, db),
    incrementEventUsage: async (organizationId, n) => {
      usage.set(organizationId, (usage.get(organizationId) ?? 0) + n);
    },
    findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe, db),
    agentRunsEnabled: async () => true,
    agentSpanDedupe: {
      findTracesWithModelCalls: (projectId, traceIds) =>
        findTracesWithModelCalls(projectId, traceIds, db),
    },
    genAiLogs: createGenAiLogStore(() => db),
    modelPricing: { loadOverrides: (projectId) => loadPriceOverrides(projectId, db) },
    otlpRawCapture: { store: createOtlpRawStore({ db, dailyCapBytes: 1_000_000_000 }) },
    ingestLog: { sink: { info: () => undefined }, lookupLabels: async () => null },
    ...scheduleDeps(db),
  } satisfies Partial<ProcessTracesDeps>;
}

function scheduleDeps(db: Db) {
  return {
    traceTurns: {
      enqueueBuild: (projectId: string) => enqueueBuildTraceTurnsJob(projectId, db),
      scheduleProjectDrain: () => undefined,
    },
    enqueueFoldIntentGraphJob: (
      projectId: string,
      _payload: undefined,
      options: { minIntervalMs: number },
    ) => enqueueFoldIntentGraphJob(projectId, db, options),
    enqueueClusterIntentsJob: (
      projectId: string,
      _payload: undefined,
      options: { minIntervalMs: number },
    ) => enqueueClusterIntentsJob(projectId, db, options),
    scheduleProjectDrain: () => undefined,
  };
}

function authDeps({ db }: Deployment) {
  return {
    isDbConfigured: () => true,
    hashApiKey: (plaintext: string) => `hashed:${plaintext}`,
    findActiveApiKeyByHash: async (hash: string) => {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
      return row ?? null;
    },
    touchApiKey: async (id: string) => {
      await touchApiKeyAt(id, new Date(), db);
    },
    getOrganizationByProjectId: async () => ORGANIZATION as never,
    shouldSampleRejection: () => false,
    ...silent,
  };
}

export function tracesRouteDeps(
  deployment: Deployment,
  over: Partial<TracesHandlerDeps> = {},
): TracesHandlerDeps {
  return {
    scope: "ingest:traces",
    ...authDeps(deployment),
    ...storeDeps(deployment),
    checkEventQuota: async () => ({ ok: true }),
    quotaGate: createQuotaGate(),
    ...over,
  };
}

export function acceptOnto(queue: Pick<EnvelopeQueue, "publish">): AcceptDeps {
  return { queue, findOrganizationId: async () => ORGANIZATION_ID };
}

export interface ProcessOverrides {
  traces?: Partial<ProcessTracesDeps>;
}

export function processTracesDeps(
  deployment: Deployment,
  over: Partial<ProcessTracesDeps> = {},
): ProcessTracesDeps {
  return {
    ...storeDeps(deployment),
    ...silent,
    logWarn: (message, fields) => deployment.logs.push({ message, fields }),
    logError: (message, _error, fields) => deployment.logs.push({ message, fields }),
    reportServerException: (() => undefined) as never,
    touchApiKeyAt: (id, at) => touchApiKeyAt(id, at, deployment.db),
    ...over,
  };
}

export function envelopeHandler(
  deployment: Deployment,
  over: ProcessOverrides = {},
): EnvelopeHandler {
  const unexpected = async (): Promise<never> => assert.fail("no process function for this signal");
  return createEnvelopeHandler({
    findProject: async (projectId) =>
      projectId === PROJECT_ID ? { organization: ORGANIZATION as never } : null,
    traces: (envelope, context) =>
      processTraces(envelope, context, processTracesDeps(deployment, over.traces)),
    logs: unexpected,
    events: unexpected,
  });
}

/** The deployment's spool. */
export function spoolQueue({ db }: Deployment): EnvelopeQueue {
  return createPostgresQueue({ db, policy: FAST_POLICY, pollMs: 5 });
}

/** Runs a consumer until `count` deliveries ended, and stops it. */
export async function drain(
  queue: EnvelopeQueue,
  handler: EnvelopeHandler,
  count: number,
): Promise<SettledDelivery[]> {
  const settled: SettledDelivery[] = [];
  const consumer = queue.consume(handler, { onSettled: (delivery) => settled.push(delivery) });
  const deadline = Date.now() + 20_000;
  while (settled.length < count) {
    assert.ok(Date.now() < deadline, `timed out after ${settled.length} of ${count} deliveries`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await consumer.stop();
  return settled;
}

export interface IngestBody {
  contentType: string;
  bytes: Uint8Array;
  contentEncoding?: string;
  key?: string;
}

export function ingestRequest(
  signal: "traces" | "logs" | "events",
  { contentType, bytes, contentEncoding, key = SECRET_KEY }: IngestBody,
): Request {
  return new Request(`http://localhost/api/v1/${signal}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${key}`,
      ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
    },
    body: Buffer.from(bytes),
  });
}

export async function ingestTraces(
  deployment: Deployment,
  bodies: readonly IngestBody[],
  accept?: AcceptDeps,
): Promise<void> {
  for (const body of bodies) {
    const response = await handleTracesRequest(
      ingestRequest("traces", body),
      tracesRouteDeps(deployment, accept ? { accept } : {}),
    );
    assert.equal(response.status, 202, await response.text());
  }
}

/** Columns that differ between two runs of the same input: random ids, and the time of the store. */
const VOLATILE: Record<string, readonly string[]> = {
  "*": ["received_at", "created_at", "updated_at"],
  api_keys: ["last_used_at"],
  events: ["id"],
  event_metrics: ["id", "event_id"],
  jobs: ["id"],
  otlp_raw_exports: ["id"],
  runtime_catalog_entries: ["first_seen_at"],
  runtime_event_sources: ["first_seen_at", "last_seen_at"],
  trace_event_rejects: [],
};

/** Tables of the queue itself. */
const QUEUE_TABLES = new Set(["ingest_spool"]);

/** Every row of every table, sorted, without the volatile columns. A metrics row names its event. */
export async function dumpTables(
  { client }: Deployment,
  { keep = [] }: { keep?: readonly string[] } = {},
): Promise<Record<string, string[]>> {
  const { rows: names } = await client.query<{ name: string }>(
    `select table_name as name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  );
  const dump: Record<string, string[]> = {};
  for (const { name } of names) {
    if (QUEUE_TABLES.has(name)) continue;
    const { rows } = await client.query<{ row: Record<string, unknown> }>(
      name === "event_metrics"
        ? `select to_jsonb(t) || jsonb_build_object('event', e.dedupe_hash) as row
           from event_metrics t join events e on e.id = t.event_id`
        : `select to_jsonb(t) as row from "${name}" t`,
    );
    const volatile = [...VOLATILE["*"], ...(VOLATILE[name] ?? [])].filter(
      (column) => !keep.includes(`${name}.${column}`),
    );
    dump[name] = rows
      .map(({ row }) => {
        for (const column of volatile) delete row[column];
        return JSON.stringify(row, sortedKeys);
      })
      .sort();
  }
  return dump;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}
