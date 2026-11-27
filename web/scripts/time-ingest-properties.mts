/**
 * RTL-395: the ingest time of one export, without and with trace properties (ADR-0012).
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55495/ratel \
 *     pnpm --filter @ratel/platform exec tsx scripts/time-ingest-properties.mts [--runs 200]
 *
 * POSTs a real export (`lib/ingest/otlp/__fixtures__/real/langgraph-openinference`, the largest
 * one) to the traces route handler, with the production write path on a migrated local database,
 * `--runs` times in each mode, each time under new trace and span ids so every run writes. Modes:
 * - `off`: no trace properties (the flag off, or before RTL-395);
 * - `warm`: trace properties on, every key written in the last hour (the in-process cache);
 * - `cold`: trace properties on, a new process cache for every export (one key write and one
 *   read of the indexed names per export: the worst case).
 * Prints the median and the 95th percentile of each mode. Refuses a database that is not on this
 * machine. Writes into one project of its own and deletes it at the end.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { decodeOtlpRequest } from "@/lib/ingest/otlp/decode";
import {
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { createPropertyIngest } from "@/lib/ingest/properties/ingest";
import { loadIndexedProperties, recordPropertyKeys } from "@/lib/ingest/properties/store";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { getDb } from "@/lib/platform/db/client";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "200" } } });
const RUNS = Number(args.runs);
const FIXTURE = join(
  import.meta.dirname,
  "../src/lib/ingest/otlp/__fixtures__/real/langgraph-openinference",
);

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host))
    throw new Error(`refusing ${host}: run the timing on a local database`);
  const db = getDb();
  const projectId = randomUUID();
  await db.execute(sql`insert into projects (id, organization_id, name, slug)
    values (${projectId}::uuid, ${randomUUID()}::uuid, 'ingest timing', ${`timing-${projectId}`})`);
  const file = readdirSync(FIXTURE).find((name) => name.endsWith(".gz"))!;
  const contentType = file.includes(".json") ? "application/json" : "application/x-protobuf";
  const request = decodeOtlpRequest(contentType, gunzipSync(readFileSync(join(FIXTURE, file))));
  const spanCount = request.resourceSpans?.reduce(
    (n, r) => n + (r.scopeSpans ?? []).reduce((m, s) => m + (s.spans?.length ?? 0), 0),
    0,
  );
  console.log(`fixture: ${file}, ${spanCount} spans; ${RUNS} runs per mode`);
  try {
    const store = {
      record: (id: string, sightings: Parameters<typeof recordPropertyKeys>[1]) =>
        recordPropertyKeys(id, sightings, db),
      indexed: (id: string) => loadIndexedProperties(id, db),
    };
    const warm = createPropertyIngest({ enabled: async () => true, ...store, now: Date.now });
    // Interleaved, one run of each mode in turn, so a busy machine slows every mode alike.
    const modes = ["off", "warm", "cold"] as const;
    const times: Record<(typeof modes)[number], number[]> = { off: [], warm: [], cold: [] };
    for (let run = 0; run < RUNS; run += 1)
      for (const mode of modes) {
        const properties =
          mode === "off"
            ? undefined
            : mode === "warm"
              ? warm.capture
              : createPropertyIngest({ enabled: async () => true, ...store, now: Date.now }).capture;
        const body = JSON.stringify(renumbered(request));
        const started = performance.now();
        const res = await handleTracesRequest(post(body), deps(projectId, db, properties));
        times[mode].push(performance.now() - started);
        if (res.status !== 202) throw new Error(`ingest answered ${res.status}`);
      }
    const rows = Object.fromEntries(
      modes.map((mode) => {
        const sorted = times[mode].sort((a, b) => a - b);
        return [
          mode,
          {
            median: round(sorted[Math.floor(sorted.length / 2)]!),
            p95: round(sorted[Math.floor(sorted.length * 0.95)]!),
          },
        ];
      }),
    );
    console.table(rows);
  } finally {
    await db.execute(sql`delete from projects where id = ${projectId}::uuid`);
  }
  process.exit(0);
}

function deps(
  projectId: string,
  db: ReturnType<typeof getDb>,
  properties: TracesHandlerDeps["properties"],
): TracesHandlerDeps {
  return {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => s,
    findActiveApiKeyByHash: async () => ({
      id: "timing",
      projectId,
      name: "timing",
      keyHash: "timing",
      keyPrefix: "rtl_t",
      createdAt: new Date(),
      lastUsedAt: new Date(),
      revokedAt: null,
      expiresAt: null,
      scopes: ["*"],
      rateLimitPerMinute: null,
    }),
    touchApiKey: async () => {},
    insertEventsWithMetrics: (id, rows) => insertEventsWithMetrics(id, rows, db),
    insertTraceEvents: (id, events) => insertTraceEvents(id, events, db),
    insertOtelSpans: (id, rows) => insertOtelSpans(id, rows, db),
    shouldSampleRejection: () => false,
    logError: () => {},
    logWarn: () => {},
    agentSpanDedupe: {
      findTracesWithModelCalls: (id, traceIds) => findTracesWithModelCalls(id, traceIds, db),
    },
    ingestLog: { sink: () => {}, lookupLabels: async () => null } as never,
    ...(properties ? { properties } : {}),
  };
}

/** The export as OTLP/JSON with new trace and span ids, so every run writes new rows. */
function renumbered(request: ReturnType<typeof decodeOtlpRequest>): unknown {
  const ids = new Map<string, string>();
  const swap = (bytes: unknown, size: number): string | undefined => {
    if (!bytes) return undefined;
    const hex = Buffer.from(bytes as Uint8Array).toString("hex");
    if (!ids.has(hex)) ids.set(hex, randomBytes(size).toString("hex"));
    return ids.get(hex);
  };
  const json = JSON.parse(JSON.stringify(request, (_key, value) => value));
  json.resourceSpans?.forEach((resource: any, r: number) =>
    resource.scopeSpans?.forEach((scope: any, s: number) =>
      scope.spans?.forEach((span: any, i: number) => {
        const raw = request.resourceSpans![r]!.scopeSpans![s]!.spans![i]!;
        span.traceId = swap(raw.traceId, 16);
        span.spanId = swap(raw.spanId, 8);
        span.parentSpanId = swap(raw.parentSpanId, 8) ?? "";
        span.startTimeUnixNano = String(raw.startTimeUnixNano);
        span.endTimeUnixNano = String(raw.endTimeUnixNano);
      }),
    ),
  );
  return json;
}

function post(body: string): Request {
  return new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer timing" },
    body,
  });
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

main().catch((err) => {
  console.error(`timing failed: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
