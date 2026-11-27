import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import protobuf from "protobufjs";
import { addressLookup } from "@/lib/ingest/geo/address";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";
import { createGeoIngest, type GeoIngestDeps } from "@/lib/ingest/geo/ingest";
import { mmdbFixture } from "@/lib/ingest/geo/mmdb-fixture";
import { editOtlpExport } from "@/lib/ingest/otlp/decode";
import descriptor from "@/lib/ingest/otlp/proto/otlp-trace.descriptor.json";
import {
  findStoredOtelSpans,
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import { drainIngestBatches } from "@/lib/ingest/queue/drain";
import { type IngestPersistDeps, persistIngestBatch } from "@/lib/ingest/queue/persist";
import {
  claimNextIngestBatch,
  enqueueIngestBatch,
  failIngestBatch,
  markIngestBatchDone,
  retryIngestBatch,
} from "@/lib/ingest/queue/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  type Db,
  ORGANIZATION_ID,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  recomputeTraceSummaries,
  type TraceSummaryExecutor,
} from "@/lib/synthesis/traces/summary-refresh";

/** The location rules with the ingest queue on: an address is resolved before the batch is queued. */

const ADDRESS = "8.8.8.8";
const TRACE = "1".padStart(32, "0");
const LATITUDE = "37.771234";
const LOOKUP = addressLookup(
  mmdbFixture({
    "8.8.8.0/24": { country: { iso_code: "US" }, subdivisions: [{ names: { en: "California" } }] },
  }),
);
const ORG = { id: ORGANIZATION_ID, slug: "acme", plan: "free" } as never;
const KEY = { id: "key-1", projectId: PROJECT_ID, scopes: ["*"], lastUsedAt: new Date() };

for (const { name, send } of [
  { name: "json", send: () => post(exportJson(ADDRESS)) },
  {
    name: "gzipped json",
    send: () => post(gzipSync(exportJson(ADDRESS)), { "Content-Encoding": "gzip" }),
  },
  {
    name: "protobuf",
    send: () =>
      post(protobufOf(exportJson(ADDRESS)), {
        "Content-Type": "application/x-protobuf",
      }),
  },
]) {
  test(`${name}: an address is in no queue row, no raw body and no stored span; the codes are stored`, async () => {
    const h = await setup();
    assert.equal((await handleTracesRequest(send(), h.route)).status, 202);

    const [row] = await h.queueRows();
    assert.equal(row.status, "queued");
    assert.deepEqual(row.context, { appendOnly: false, geo: { addressed: true } });
    const body = (
      row.content_encoding === "gzip" ? gunzipSync(row.body) : Buffer.from(row.body)
    ).toString("latin1");
    assert.ok(body.includes("ratel.geo.country") && body.includes("US-CA"));
    // The search does find what the export holds.
    assert.ok(Buffer.from(exportJson(ADDRESS)).includes(ADDRESS));
    for (const text of [ADDRESS, LATITUDE]) {
      assert.ok(!body.includes(text), `${text} is in the queue row`);
      assert.deepEqual(await rowsWith(h.client, text), []);
    }

    assert.deepEqual(await h.drain(), { done: 1, failed: 0, retried: 0 });
    const spans = await h.client.query<{ n: number }>("select count(*)::int as n from otel_spans");
    assert.equal(spans.rows[0].n, 2);
    for (const text of [ADDRESS, LATITUDE]) assert.deepEqual(await rowsWith(h.client, text), []);
    const raw = await h.client.query("select 1 from otlp_raw_exports");
    assert.equal(raw.rows.length, 0, "the raw capture keeps no body of the batch");
    assert.deepEqual(await h.place(), { geo_country: "US", geo_region: "US-CA" });
  });
}

test("a batch without a location is queued as sent, and its raw body is kept", async () => {
  const h = await setup();
  const sent = exportJson();
  await handleTracesRequest(post(sent), h.route);
  const [row] = await h.queueRows();
  assert.deepEqual(Buffer.from(row.body), sent);
  assert.deepEqual(row.context, { appendOnly: false });
  await h.drain();
  const raw = await h.client.query("select 1 from otlp_raw_exports");
  assert.equal(raw.rows.length, 1);
});

test("codes the emitter sent under Ratel's names are not believed", async () => {
  const h = await setup();
  await handleTracesRequest(
    post(exportJson("10.0.0.1", [attribute("ratel.geo.country", "FR")])),
    h.route,
  );
  await h.drain();
  assert.deepEqual(await h.place(), { geo_country: null, geo_region: null });
});

test("a batch whose address cannot be told is not queued: it is stored at once, without its raw body", async () => {
  const h = await setup({
    attributes: async () => {
      throw new Error("no database");
    },
  });
  assert.equal((await handleTracesRequest(post(exportJson(ADDRESS)), h.route)).status, 202);
  assert.deepEqual(await h.queueRows(), []);
  assert.deepEqual(await rowsWith(h.client, ADDRESS), []);
  const stored = await h.client.query<{ n: number }>("select count(*)::int as n from otel_spans");
  assert.equal(stored.rows[0].n, 2);
  const raw = await h.client.query("select 1 from otlp_raw_exports");
  assert.equal(raw.rows.length, 0);
});

test("a body that does not decode is refused, not queued", async () => {
  const h = await setup();
  const response = await handleTracesRequest(post(`{"client.address": "${ADDRESS}"`), h.route);
  assert.equal(response.status, 400);
  assert.deepEqual(await h.queueRows(), []);
});

test("flag off: the batches are queued as sent, with one flag lookup for the organization", async () => {
  const h = await setup({ enabled: false });
  const sent = exportJson(ADDRESS);
  for (let batch = 0; batch < 5; batch++) {
    assert.equal((await handleTracesRequest(post(sent), h.route)).status, 202);
  }
  const rows = await h.queueRows();
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.deepEqual(Buffer.from(row.body), sent);
    assert.deepEqual(row.context, { appendOnly: false });
  }
  await h.drain();
  assert.deepEqual(h.asked, [ORGANIZATION_ID], "accepting and persisting share one lookup");
  assert.equal(h.namesRead(), 0);
  assert.deepEqual(await h.place(), { geo_country: null, geo_region: null });
});

test("an edit keeps every other field of an export", () => {
  for (const transport of ["json", "protobuf"] as const) {
    const sent = exportJson(ADDRESS);
    const bytes = transport === "json" ? sent : protobufOf(sent);
    assert.deepEqual(Buffer.from(editOtlpExport(transport, bytes, () => {})), Buffer.from(bytes));
  }
});

async function setup(over: Partial<Omit<GeoIngestDeps, "enabled">> & { enabled?: boolean } = {}) {
  const { client, db } = await setupDb();
  const asked: (string | undefined)[] = [];
  let names = 0;
  const geo = createGeoIngest({
    enabled: async ({ organizationId }) => {
      asked.push(organizationId);
      return over.enabled ?? true;
    },
    attributes:
      over.attributes ??
      (async () => {
        names++;
        return DEFAULT_GEO_ATTRIBUTES;
      }),
    address: async () => LOOKUP,
    now: () => 0,
  });
  const raw = { store: createOtlpRawStore({ db }) };
  const writes = {
    insertEventsWithMetrics: (p, rows) => insertEventsWithMetrics(p, rows, db),
    insertTraceEvents: (p, events) => insertTraceEvents(p, events, db),
    insertOtelSpans: (p, rows) => insertOtelSpans(p, rows, db),
    findStoredOtelSpans: (p, spans) => findStoredOtelSpans(p, spans, db),
    agentSpanDedupe: { findTracesWithModelCalls: (p, ids) => findTracesWithModelCalls(p, ids, db) },
    locate: geo.locate,
    otlpRawCapture: raw,
  } satisfies Partial<TracesHandlerDeps>;
  const route: TracesHandlerDeps = {
    ...writes,
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => s,
    findActiveApiKeyByHash: async () => KEY as unknown as ApiKey,
    touchApiKey: async () => {},
    getOrganizationByProjectId: async () => ORG,
    redact: geo.redact,
    ingestQueue: {
      enabled: () => true,
      enqueue: (batch) => enqueueIngestBatch(batch, db),
      scheduleDrain: () => {},
    },
    logError: () => {},
    logWarn: () => {},
    reportServerException: (() => {}) as never,
    shouldSampleRejection: () => true,
  };
  const persist: IngestPersistDeps = {
    getOrganizationByProjectId: async () => ORG,
    traces: writes,
    logs: { insertOtelLogs: async () => assert.fail("no logs here") },
    events: {
      insertTraceEvents: async () => assert.fail("no events here"),
      insertTraceEventRejects: async () => {},
    },
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    reportServerException: () => {},
  };
  return {
    client,
    route,
    asked,
    namesRead: () => names,
    drain: () =>
      drainIngestBatches(
        {
          claim: (options) => claimNextIngestBatch(db, options),
          done: (id, attempt, result) => markIngestBatchDone(id, attempt, result, db),
          fail: (id, attempt, error) => failIngestBatch(id, attempt, error, db),
          retry: (id, attempt, error, options) => retryIngestBatch(id, attempt, error, options, db),
        },
        (batch) => persistIngestBatch(batch, persist),
        {
          perProject: 1,
          maxAttempts: 5,
          log: { info: () => {}, warn: () => {}, error: () => {} },
        },
      ),
    queueRows: async () =>
      (
        await client.query<{
          status: string;
          body: Uint8Array;
          content_encoding: string | null;
          context: unknown;
        }>("select status, body, content_encoding, context from ingest_batches")
      ).rows,
    place: () => place(client, db),
  };
}

function post(body: BodyInit | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_key", ...headers },
    body: body as BodyInit,
  });
}

function protobufOf(json: Buffer): Uint8Array {
  const type = protobuf.Root.fromJSON(descriptor as protobuf.INamespace).lookupType(
    "ratel.otlp.ExportTraceServiceRequest",
  );
  return type.encode(type.fromObject(JSON.parse(json.toString(), hexIds))).finish();
}

/** The ids of OTLP/JSON are hex, and protobuf's are bytes. */
function hexIds(key: string, value: unknown) {
  return /^(traceId|spanId|parentSpanId)$/.test(key) ? Buffer.from(String(value), "hex") : value;
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** The address on the resource, the span, its event and its link. */
function exportJson(address?: string, more: object[] = []): Buffer {
  const attributes = address
    ? [attribute("client.address", address), attribute("geo.location.lat", LATITUDE), ...more]
    : more;
  const start = Date.UTC(2026, 10, 2) * 1e6;
  const span = (id: number, rest: object) => ({
    traceId: TRACE,
    spanId: String(id).padStart(16, "0"),
    kind: 1,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 1e9),
    ...rest,
  });
  return Buffer.from(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [attribute("service.name", "agent"), ...attributes] },
          scopeSpans: [
            {
              scope: { name: "ratel", attributes },
              spans: [
                span(1, {
                  name: "chat gpt-5.5",
                  attributes: [
                    attribute("gen_ai.operation.name", "chat"),
                    attribute("gen_ai.request.model", "gpt-5.5"),
                    ...attributes,
                  ],
                  events: [{ name: "gen_ai.choice", timeUnixNano: String(start), attributes }],
                  links: [{ traceId: TRACE, spanId: "2".padStart(16, "0"), attributes }],
                }),
                span(2, {
                  name: "execute_tool search",
                  parentSpanId: "1".padStart(16, "0"),
                  attributes: [
                    attribute("gen_ai.operation.name", "execute_tool"),
                    attribute("gen_ai.tool.name", "search"),
                  ],
                }),
              ],
            },
          ],
        },
      ],
    }),
  );
}

async function place(client: PGlite, db: Db) {
  await recomputeTraceSummaries(db as unknown as TraceSummaryExecutor, [
    { projectId: PROJECT_ID, traceId: TRACE },
  ]);
  const { rows } = await client.query(
    "select geo_country, geo_region from otel_trace_summaries where trace_id = $1",
    [TRACE],
  );
  return rows[0];
}

/** The tables with a row that holds the text, as text or as bytes. */
async function rowsWith(client: PGlite, text: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  );
  const found: string[] = [];
  for (const { name } of rows) {
    const { rows: hits } = await client.query<{ n: number }>(
      `select count(*)::int as n from "${name}" t where strpos(t::text, $1) > 0 or strpos(t::text, $2) > 0`,
      [text, Buffer.from(text).toString("hex")],
    );
    if (hits[0].n > 0) found.push(name);
  }
  return found;
}
