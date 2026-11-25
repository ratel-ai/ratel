import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { SettledDelivery } from "@/lib/contracts/ingest-queue";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { handleLogsRequest, type LogsHandlerDeps } from "@/lib/ingest/otlp/logs-route-handler";
import { type ProcessLogsDeps, processLogs } from "@/lib/ingest/otlp/process-logs";
import type { ProcessTracesDeps } from "@/lib/ingest/otlp/process-traces";
import { processTraces } from "@/lib/ingest/otlp/process-traces";
import {
  findStoredOtelSpans,
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelLogs,
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
import { type ProcessEventsDeps, processEvents } from "@/lib/ingest/trace-events/process-events";
import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import {
  handleRuntimeEventsRequest,
  type RuntimeEventsHandlerDeps,
} from "@/lib/ingest/trace-events/route-handler";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { getDb } from "@/lib/platform/db/client";
import * as tables from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { touchApiKeyAt } from "@/lib/platform/projects/queries";
import { apiKeys } from "@/lib/platform/projects/schema";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import {
  enqueueFoldIntentGraphJob,
  type IntentGraphDb,
  syncIntentGraphLiveFromStatus,
} from "@/lib/readings/intent-graph/queries";

/** A deployment over PGlite, in direct mode and with a queue, for the queued-ingest tests. */

export const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const SECRET_KEY_ID = "33333333-3333-4333-8333-333333333333";
export const SHARED_KEY_ID = "44444444-4444-4444-8444-444444444444";
export const SECRET_KEY = "rtl_secret";
/** A publishable key: append only, with shared limits. */
export const SHARED_KEY = "rtl_shared";

export type Db = ReturnType<typeof getDb>;

/** Stands for the edition's counter (`incrementEventUsage`), which the core does not store. */
const USAGE_TABLE = "test_event_usage";
const ORGANIZATION = { id: ORGANIZATION_ID, name: "Acme", slug: "acme" };
const FAST_POLICY: RetryPolicy = {
  waitsMs: [5, 5, 5, 5],
  outageWaitMs: { first: 5, max: 20 },
};

export interface Deployment {
  client: PGlite;
  db: Db;
  logs: { message: string; fields?: Record<string, unknown> }[];
}

export async function setupDeployment(): Promise<Deployment> {
  const client = await createMigratedPGlite();
  await client.exec(`
    create table ${USAGE_TABLE} (n integer not null);
    insert into ${USAGE_TABLE} values (0);
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
    insert into api_keys (id, project_id, key_hash, key_prefix, scopes) values
      ('${SECRET_KEY_ID}', '${PROJECT_ID}', 'hashed:${SECRET_KEY}', 'rtl_s', '{*}'),
      ('${SHARED_KEY_ID}', '${PROJECT_ID}', 'hashed:${SHARED_KEY}', 'rtl_p',
       '{ingest:traces,ingest:logs,ingest:events}');
  `);
  return deploymentOver(client);
}

/** Another process of the deployment, over the same database or a connection of it that can end. */
export function deploymentOver(client: PGlite): Deployment {
  return { client, db: drizzle(client, { schema: tables }) as unknown as Db, logs: [] };
}

/** What the edition's monthly counter holds. */
export async function usageOf({ client }: Deployment): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`select n from ${USAGE_TABLE}`);
  return rows[0].n;
}

const silent = { logWarn: () => undefined, shouldSampleSuccess: () => false };

/** What a trace store needs, the same in both modes. */
function storeDeps({ client, db }: Deployment) {
  return {
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertTraceEvents: (projectId, events, _db, options) =>
      insertTraceEvents(projectId, events, db, options),
    insertOtelSpans: (projectId, rows, _db, options) =>
      insertOtelSpans(projectId, rows, db, options),
    findStoredOtelSpans: (projectId, spans) => findStoredOtelSpans(projectId, spans, db),
    incrementEventUsage: async (_organizationId, n) => {
      await client.query(`update ${USAGE_TABLE} set n = n + $1`, [n]);
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
  logs?: Partial<ProcessLogsDeps>;
  events?: Partial<ProcessEventsDeps>;
}

export function processTracesDeps(
  deployment: Deployment,
  over: Partial<ProcessTracesDeps> = {},
): ProcessTracesDeps {
  return { ...storeDeps(deployment), ...observeDeps(deployment), ...over };
}

function observeDeps({ db, logs }: Deployment) {
  return {
    ...silent,
    logWarn: (message, fields) => logs.push({ message, fields }),
    logError: (message, _error, fields) => logs.push({ message, fields }),
    reportServerException: (() => undefined) as never,
    touchApiKeyAt: (id, at) => touchApiKeyAt(id, at, db),
  } satisfies Partial<ProcessTracesDeps>;
}

function logsStoreDeps({ db }: Deployment) {
  return {
    insertOtelLogs: (projectId, rows, _db, options) => insertOtelLogs(projectId, rows, db, options),
    genAiLogJoin: {
      store: createGenAiLogStore(() => db),
      modelPricing: { loadOverrides: (projectId: string) => loadPriceOverrides(projectId, db) },
    },
    otlpRawCapture: { store: createOtlpRawStore({ db, dailyCapBytes: 1_000_000_000 }) },
    ingestLog: { sink: { info: () => undefined }, lookupLabels: async () => null },
  } satisfies Partial<ProcessLogsDeps>;
}

export function logsRouteDeps(
  deployment: Deployment,
  over: Partial<LogsHandlerDeps> = {},
): LogsHandlerDeps {
  return { scope: "ingest:logs", ...authDeps(deployment), ...logsStoreDeps(deployment), ...over };
}

export function processLogsDeps(
  deployment: Deployment,
  over: Partial<ProcessLogsDeps> = {},
): ProcessLogsDeps {
  return { ...logsStoreDeps(deployment), ...observeDeps(deployment), ...over };
}

function eventsStoreDeps({ db }: Deployment) {
  return {
    insertTraceEvents: (projectId, events, _db, options) =>
      insertTraceEvents(projectId, events, db, {
        ...options,
        syncIntentGraphLive: (id, tx) => syncIntentGraphLiveFromStatus(id, tx as IntentGraphDb),
      }),
    insertTraceEventRejects: (projectId, rejects) =>
      insertTraceEventRejects(projectId, rejects, db),
    ...scheduleDeps(db),
  } satisfies Partial<ProcessEventsDeps>;
}

export function eventsRouteDeps(
  deployment: Deployment,
  over: Partial<RuntimeEventsHandlerDeps> = {},
): RuntimeEventsHandlerDeps {
  const auth = authDeps(deployment);
  // As the route: with a queue, the consumer stamps the key.
  if (over.accept) auth.touchApiKey = async () => undefined;
  return {
    scope: "ingest:events",
    resolveProjectFromBearer: (request, scope) => resolveProjectFromBearer(request, scope, auth),
    getOrganizationByProjectId: auth.getOrganizationByProjectId,
    rateLimiter: createTokenBucketRateLimiter({ limitPerMinute: 1_000, burst: 1_000 }),
    ...eventsStoreDeps(deployment),
    ...over,
  };
}

export function processEventsDeps(
  deployment: Deployment,
  over: Partial<ProcessEventsDeps> = {},
): ProcessEventsDeps {
  const { logError, reportServerException, touchApiKeyAt: touch } = observeDeps(deployment);
  return {
    ...eventsStoreDeps(deployment),
    logError,
    reportServerException,
    touchApiKeyAt: touch,
    ...over,
  };
}

export function envelopeHandler(
  deployment: Deployment,
  over: ProcessOverrides = {},
): EnvelopeHandler {
  return createEnvelopeHandler({
    findProject: async (projectId) =>
      projectId === PROJECT_ID ? { organization: ORGANIZATION as never } : null,
    traces: (envelope, context) =>
      processTraces(envelope, context, processTracesDeps(deployment, over.traces)),
    logs: (envelope, context) =>
      processLogs(envelope, context, processLogsDeps(deployment, over.logs)),
    events: (envelope, context) =>
      processEvents(envelope, context, processEventsDeps(deployment, over.events)),
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

export async function ingestLogs(
  deployment: Deployment,
  bodies: readonly IngestBody[],
  accept?: AcceptDeps,
): Promise<void> {
  for (const body of bodies) {
    const response = await handleLogsRequest(
      ingestRequest("logs", body),
      logsRouteDeps(deployment, accept ? { accept } : {}),
    );
    assert.equal(response.status, 202, await response.text());
  }
}

export async function ingestEvents(
  deployment: Deployment,
  bodies: readonly IngestBody[],
  accept?: AcceptDeps,
): Promise<void> {
  for (const body of bodies) {
    const response = await handleRuntimeEventsRequest(
      ingestRequest("events", body),
      eventsRouteDeps(deployment, accept ? { accept } : {}),
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
  trace_event_hits: ["id"],
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

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const START_NANO = "1763632800000000000"; // 2025-11-20T10:00:00Z

const json = (value: unknown): IngestBody => ({
  contentType: "application/json",
  bytes: new TextEncoder().encode(JSON.stringify(value)),
});

const attributes = (values: Record<string, string | boolean>) =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "boolean" ? { boolValue: value } : { stringValue: value },
  }));

/** One model call, whose content comes in {@link logsBody}. */
export function modelCallBody(startTimeUnixNano = START_NANO): IngestBody {
  const span = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: "chat",
    startTimeUnixNano,
    endTimeUnixNano: startTimeUnixNano,
    attributes: [
      ...attributes({ "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5.5" }),
      { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
    ],
  };
  return json({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });
}

/** The call's content, a catalog definition, a record without a time, and one that is not kept. */
export function logsBody(key = SECRET_KEY): IngestBody {
  const logRecords = [
    {
      timeUnixNano: START_NANO,
      eventName: "gen_ai.client.inference.operation.details",
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      attributes: attributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.input.messages":
          '[{"role":"user","parts":[{"type":"text","content":"Weather in Rome?"}]}]',
        "gen_ai.output.messages":
          '[{"role":"assistant","parts":[{"type":"text","content":"Sunny."}],"finish_reason":"stop"}]',
      }),
    },
    {
      timeUnixNano: START_NANO,
      eventName: "ratel.catalog.definition",
      attributes: [
        ...attributes({
          "ratel.catalog.kind": "tool",
          "ratel.catalog.id": "send_invoice",
          "ratel.catalog.name": "send_invoice",
          "ratel.catalog.description": "Sends an invoice",
          "ratel.catalog.input_schema": "true",
          "ratel.catalog.output_schema": "true",
          "ratel.catalog.searchable_description": "Sends an invoice",
          "ratel.catalog.searchable_description_overridden": false,
          "ratel.catalog.content_hash": "b".repeat(64),
        }),
        { key: "ratel.catalog.tags", value: { arrayValue: { values: [] } } },
      ],
    },
    { eventName: "ratel.note", attributes: attributes({ "ratel.event.id": "note-1" }) },
    { timeUnixNano: START_NANO, eventName: "app.log", body: { stringValue: "not kept" } },
  ];
  return { ...json({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }), key };
}

/** Runtime events of every kind that ingest treats on its own, and two that it rejects. */
export function eventsBody(at: number, key = SECRET_KEY): IngestBody {
  const base = { v: 2, ts: at, session_id: "session-1", source_id: "worker-a" };
  return {
    ...json({
      events: [
        {
          ...base,
          event_id: "search-1",
          type: "search",
          origin: "agent",
          query: "weather",
          top_k: 5,
          hits: [{ tool_id: "get_weather", score: 1 }],
          took_ms: 3,
        },
        {
          ...base,
          event_id: "start-1",
          type: "invoke_start",
          tool_id: "get_weather",
          invocation_id: "i-1",
          args_size_bytes: 10,
        },
        {
          ...base,
          event_id: "end-1",
          type: "invoke_end",
          tool_id: "get_weather",
          invocation_id: "i-1",
          took_ms: 12,
          result_size_bytes: 20,
        },
        {
          ...base,
          event_id: "status-1",
          type: "usage_ranking_status",
          status: "active",
          reason: "enabled",
          rev: 1,
        },
        { ...base, event_id: "exp-1", type: "experiment_drop", experiment_id: "e", reason: "late" },
        { ...base, event_id: "later-1", type: "sdk_added_later", extra: true },
        { ...base, event_id: "bad-1", type: "search" },
        { nonsense: true },
      ],
    }),
    key,
  };
}

/** What a killed process' statements throw. */
export class Killed extends Error {
  override name = "Killed";
}

/**
 * A connection whose process dies at its `at`-th statement: that one and every later one throw, and
 * an open transaction rolls back. A commit counts as a statement.
 */
export function killableClient(
  client: PGlite,
  at: number,
): { client: PGlite; dead: () => boolean; statements: () => number } {
  let statements = 0;
  let dead = false;
  const step = () => {
    if (!dead) statements += 1;
    dead ||= statements >= at;
    if (dead) throw new Killed("the process is gone");
  };
  const wrap = <Target extends object>(target: Target): Target =>
    new Proxy(target, {
      get(object, name) {
        const value = Reflect.get(object, name);
        if (typeof value !== "function") return value;
        if (name === "query" || name === "exec") {
          return async (...args: unknown[]) => {
            step();
            return value.apply(object, args);
          };
        }
        if (name === "transaction") {
          return async (run: (tx: object) => Promise<unknown>) => {
            step();
            return value.call(object, async (tx: object) => {
              const result = await run(wrap(tx));
              step();
              return result;
            });
          };
        }
        return value.bind(object);
      },
    });
  return { client: wrap(client), dead: () => dead, statements: () => statements };
}
