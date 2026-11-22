import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type Attr,
  ingest,
  otlp,
  post,
  type SpanSpec,
} from "@/lib/ingest/otlp/dimensions/client-facts-support";
import { mmdbGeoLookup, NO_GEO } from "@/lib/ingest/otlp/dimensions/geo";
import { PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import { recomputeTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";

/**
 * Client facts end to end (RC-773): OTLP exports POSTed to the traces route
 * against a migrated database, one request per export, then the client
 * columns read back from `otel_spans` and the harness from `trace_events`.
 */

const SERVER = 2;
const T1 = "a".repeat(32);
const T2 = "b".repeat(32);
const [HTTP, CALL, INIT, LATER] = ["1", "2", "3", "4"].map((d) => d.repeat(16)) as [
  string,
  string,
  string,
  string,
];

const toolsCall = (over: Partial<SpanSpec> = {}, attributes: Attr = {}): SpanSpec => ({
  traceId: T1,
  spanId: CALL,
  parentSpanId: HTTP,
  name: "tools/call get-weather",
  kind: SERVER,
  startMs: 5,
  endMs: 50,
  attributes: {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "get-weather",
    ...attributes,
  },
  ...over,
});

const initialize = (attributes: Attr = {}): SpanSpec => ({
  traceId: T2,
  spanId: INIT,
  name: "initialize",
  kind: SERVER,
  startMs: 0,
  endMs: 2,
  attributes: {
    "mcp.method.name": "initialize",
    "mcp.session.id": "sess-1",
    "mcp.protocol.version": "2025-11-25",
    "mcp.client.name": "claude-code",
    "mcp.client.version": "2.1.3",
    "network.transport": "tcp",
    ...attributes,
  },
});

const laterCall = (): SpanSpec => ({
  ...toolsCall({
    traceId: "c".repeat(32),
    spanId: LATER,
    parentSpanId: undefined,
    startMs: 100,
    endMs: 120,
  }),
  attributes: {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "get-weather",
    "mcp.session.id": "sess-1",
  },
});

interface FactsRow {
  harness: string | null;
  harness_raw: string | null;
  harness_version: string | null;
  harness_source: string | null;
  geo_country: string | null;
  mcp_transport: string | null;
  mcp_protocol_version: string | null;
}

async function factsOf(client: PGlite, spanId: string): Promise<FactsRow> {
  const { rows } = await client.query<FactsRow>(
    `select harness, harness_raw, harness_version, harness_source, geo_country, mcp_transport, mcp_protocol_version
     from otel_spans where span_id = $1`,
    [spanId],
  );
  assert.equal(rows.length, 1, `one row for ${spanId}`);
  return rows[0]!;
}

const NULL_FACTS: FactsRow = {
  harness: null,
  harness_raw: null,
  harness_version: null,
  harness_source: null,
  geo_country: null,
  mcp_transport: null,
  mcp_protocol_version: null,
};

const HTTP_SPAN: SpanSpec = {
  traceId: T1,
  spanId: HTTP,
  name: "POST /mcp",
  kind: SERVER,
  startMs: 0,
  endMs: 60,
  attributes: {
    "http.request.method": "POST",
    "url.path": "/mcp",
    "user_agent.original": "claude-code/2.1.3 (external, cli)",
    "client.address": "203.0.113.7",
  },
};

test("a trace with an HTTP server span and an MCP tools/call span stores the harness from the HTTP span, and no IP", async () => {
  const { client } = await ingest([otlp([HTTP_SPAN, toolsCall()])]);
  assert.deepEqual(await factsOf(client, CALL), {
    harness: "claude-code",
    harness_raw: "claude-code",
    harness_version: "2.1.3",
    harness_source: "heuristic",
    geo_country: null,
    mcp_transport: "http",
    mcp_protocol_version: null,
  });
  assert.deepEqual(await factsOf(client, HTTP), NULL_FACTS, "the HTTP span is no MCP span");

  const { rows } = await client.query(
    `select span_id, harness from trace_events where ingest_source = 'otlp'`,
  );
  assert.deepEqual(
    rows,
    [{ span_id: CALL, harness: "claude-code" }],
    "trace_events.harness is filled for the OTLP tool row",
  );

  const { rows: stored } = await client.query(`select * from otel_spans`);
  assert.equal(
    JSON.stringify(stored).includes("203.0.113.7"),
    false,
    "no column or attribute keeps the caller's IP (RP-138)",
  );
  await client.close();
});

test("an initialize in one request sets the facts of its session's spans that arrive in a later request", async () => {
  const { client } = await ingest([otlp([initialize()]), otlp([laterCall()])]);
  const expected: FactsRow = {
    harness: "claude-code",
    harness_raw: "claude-code",
    harness_version: "2.1.3",
    harness_source: "semconv",
    geo_country: null,
    mcp_transport: "http",
    mcp_protocol_version: "2025-11-25",
  };
  assert.deepEqual(await factsOf(client, LATER), expected);
  assert.deepEqual(
    await factsOf(client, INIT),
    { ...expected, harness_source: "sdk" },
    "the initialize span's own attribute",
  );
  await client.close();
});

test("an initialize that arrives after its session's spans fills the stored rows", async () => {
  const { client } = await ingest([otlp([laterCall()]), otlp([initialize()])]);
  assert.deepEqual(await factsOf(client, LATER), {
    harness: "claude-code",
    harness_raw: "claude-code",
    harness_version: "2.1.3",
    harness_source: "semconv",
    geo_country: null,
    mcp_transport: "http",
    mcp_protocol_version: "2025-11-25",
  });
  await client.close();
});

test("the session's client name wins over a later request's User-Agent", async () => {
  const http: SpanSpec = {
    ...HTTP_SPAN,
    traceId: "c".repeat(32),
    spanId: "5".repeat(16),
    startMs: 90,
    endMs: 130,
    attributes: {
      ...HTTP_SPAN.attributes,
      "user_agent.original": "node",
      "client.address": "198.51.100.4",
    },
  };
  const { client } = await ingest([
    otlp([initialize()]),
    otlp([http, { ...laterCall(), parentSpanId: http.spanId }]),
  ]);
  const facts = await factsOf(client, LATER);
  assert.equal(facts.harness, "claude-code");
  assert.equal(facts.harness_source, "semconv");
  await client.close();
});

test("a stdio trace with no client facts stores null and is accepted", async () => {
  const stdio = toolsCall({ parentSpanId: undefined }, { "network.transport": "pipe" });
  const bare = toolsCall({ traceId: T2, spanId: LATER, parentSpanId: undefined });
  const { client } = await ingest([otlp([stdio, bare])]);
  assert.deepEqual(await factsOf(client, CALL), { ...NULL_FACTS, mcp_transport: "stdio" });
  assert.deepEqual(await factsOf(client, LATER), NULL_FACTS);
  const { rows } = await client.query(
    `select span_id, harness from trace_events where ingest_source = 'otlp' order by span_id`,
  );
  assert.deepEqual(rows, [
    { span_id: CALL, harness: null },
    { span_id: LATER, harness: null },
  ]);
  await client.close();
});

test("a failed session lookup is logged and the batch is still stored with its own facts", async () => {
  const logged: string[] = [];
  const { client, db } = await ingest([otlp([initialize()])]);
  await post(db, [otlp([laterCall()])], {
    clientSessions: {
      find: async () => {
        throw new Error("db down");
      },
      fill: async () => {},
    },
    logError: (message, err) =>
      logged.push(`${message}: ${err instanceof Error ? err.message : String(err)}`),
  });
  assert.deepEqual(logged, ["mcp session client facts lookup failed: db down"]);
  assert.deepEqual(await factsOf(client, LATER), NULL_FACTS);
  await client.close();
});

/* — Real SDK exports (lib/otlp/__fixtures__/client-facts/README.md) ———————————————— */

const REAL = join(process.cwd(), "lib/ingest/otlp/__fixtures__/client-facts");
const real = (file: string) => readFileSync(join(REAL, file), "utf8");

async function toolsCallFacts(
  client: PGlite,
  service: string,
): Promise<FactsRow & { name: string }> {
  const { rows } = await client.query<FactsRow & { name: string }>(
    `select name, harness, harness_raw, harness_version, harness_source, geo_country, mcp_transport, mcp_protocol_version
     from otel_spans where service_name = $1 and name like 'tools/call%'`,
    [service],
  );
  assert.equal(rows.length, 1, service);
  return rows[0]!;
}

test("real exports of the TS MCP SDK over HTTP: two harnesses, each from its own User-Agent, sent as separate requests", async () => {
  const { client } = await ingest([
    real("ts-http-claude-code-initialize.otlp.json"),
    real("ts-http-claude-code-tools-call.otlp.json"),
    real("ts-http-cursor-initialize.otlp.json"),
    real("ts-http-cursor-tools-call.otlp.json"),
  ]);
  const { rows } = await client.query<FactsRow & { mcp_session_id: string }>(
    `select mcp_session_id, harness, harness_raw, harness_version, harness_source, geo_country, mcp_transport, mcp_protocol_version
     from otel_spans where name like 'tools/call%' order by harness`,
  );
  const http = {
    geo_country: null,
    mcp_transport: "http",
    mcp_protocol_version: "2025-11-25",
    harness_source: "heuristic",
  };
  assert.deepEqual(rows, [
    {
      mcp_session_id: "a057008d-3c83-408f-8553-94c2c0aca23f",
      harness: "claude-code",
      harness_raw: "claude-code",
      harness_version: "2.1.3",
      ...http,
    },
    {
      mcp_session_id: "19693652-248b-434d-9052-af5ab41ec448",
      harness: "cursor",
      harness_raw: "Cursor",
      harness_version: "1.7.0",
      ...http,
    },
  ]);
  const { rows: events } = await client.query(
    `select tool_id, harness from trace_events where ingest_source = 'otlp' order by harness`,
  );
  assert.deepEqual(events, [
    { tool_id: "get_forecast", harness: "claude-code" },
    { tool_id: "get_forecast", harness: "cursor" },
  ]);
  await client.close();
});

test("real exports of the Python MCP SDK over stdio: no client facts, only the protocol version, and nothing fails", async () => {
  const { client } = await ingest([
    real("py-stdio-codex-initialize.otlp.json"),
    real("py-stdio-codex-tools-call.otlp.json"),
  ]);
  assert.deepEqual(await toolsCallFacts(client, "notes-mcp"), {
    name: "tools/call search_notes",
    ...NULL_FACTS,
    mcp_protocol_version: "2025-11-25",
  });
  await client.close();
});

/* — Geo (RC-774) ———————————————————————————————————————————————————————————— */

const GEO = mmdbGeoLookup(
  readFileSync(join(process.cwd(), "lib/ingest/otlp/__fixtures__/geo/GeoIP2-Country-Test.mmdb")),
);

test("an HTTP server span and an MCP tools/call span: harness, geo_country and mcp_transport on otel_spans, no IP, countries on the trace summary", async () => {
  const http: SpanSpec = {
    ...HTTP_SPAN,
    attributes: { ...HTTP_SPAN.attributes, "client.address": "81.2.69.160" },
  };
  const { client, db } = await ingest([otlp([http, toolsCall()])], { geo: GEO });
  const { rows } = await client.query(
    `select harness, geo_country, mcp_transport from otel_spans where span_id = $1`,
    [CALL],
  );
  assert.deepEqual(rows, [{ harness: "claude-code", geo_country: "GB", mcp_transport: "http" }]);
  const { rows: stored } = await client.query(`select * from otel_spans`);
  assert.equal(JSON.stringify(stored).includes("81.2.69.160"), false, "the IP is dropped");

  await recomputeTraceSummaries(db, [{ projectId: PROJECT_ID, traceId: T1 }]);
  const { rows: summaries } = await client.query(
    `select countries from otel_trace_summaries where trace_id = $1`,
    [T1],
  );
  assert.deepEqual(summaries, [{ countries: ["GB"] }]);
  await client.close();
});

test("a private or documentation address stores null geo", async () => {
  const { client } = await ingest([otlp([HTTP_SPAN, toolsCall()])], { geo: GEO });
  const { rows } = await client.query(`select geo_country from otel_spans where span_id = $1`, [
    CALL,
  ]);
  assert.deepEqual(rows, [{ geo_country: null }]);
  await client.close();
});

test("with no geo file, ingest stores null geo and the other facts", async () => {
  const http: SpanSpec = {
    ...HTTP_SPAN,
    attributes: { ...HTTP_SPAN.attributes, "client.address": "81.2.69.160" },
  };
  const { client } = await ingest([otlp([http, toolsCall()])], { geo: NO_GEO });
  const { rows } = await client.query(
    `select harness, geo_country from otel_spans where span_id = $1`,
    [CALL],
  );
  assert.deepEqual(rows, [{ harness: "claude-code", geo_country: null }]);
  await client.close();
});

test("a session's later request takes the IP's country from the initialize; a back-filled row gets it too", async () => {
  const init = initialize({ "client.address": "89.160.20.112" });
  const forward = await ingest([otlp([init]), otlp([laterCall()])], { geo: GEO });
  const back = await ingest([otlp([laterCall()]), otlp([init])], { geo: GEO });
  for (const { client } of [forward, back]) {
    const { rows } = await client.query(`select geo_country from otel_spans where span_id = $1`, [
      LATER,
    ]);
    assert.deepEqual(rows, [{ geo_country: "SE" }]);
    await client.close();
  }
});

/* — The ingest strip (RP-138: FF_INGEST_STRIP_CLIENT_ADDRESS) ——————————————————————— */

test("with the address strip on, ingest still reads the caller's country, and no table keeps the IP", async () => {
  const http: SpanSpec = {
    ...HTTP_SPAN,
    attributes: { ...HTTP_SPAN.attributes, "client.address": "81.2.69.160" },
  };
  const init = initialize({ "client.address": "89.160.20.112" });
  const { client } = await ingest([otlp([http, toolsCall()]), otlp([init]), otlp([laterCall()])], {
    geo: GEO,
    stripClientAddresses: () => true,
  });
  const { rows } = await client.query(
    `select span_id, geo_country from otel_spans where span_id in ($1, $2) order by span_id`,
    [CALL, LATER],
  );
  assert.deepEqual(rows, [
    { span_id: CALL, geo_country: "GB" },
    { span_id: LATER, geo_country: "SE" },
  ]);
  const { rows: stored } = await client.query(`select * from otel_spans`);
  const text = JSON.stringify(stored);
  assert.equal(text.includes("81.2.69.160") || text.includes("89.160.20.112"), false);
  await client.close();
});

test("with the address strip on and no geo file, the country stays null and ingest goes on", async () => {
  const http: SpanSpec = {
    ...HTTP_SPAN,
    attributes: { ...HTTP_SPAN.attributes, "client.address": "81.2.69.160" },
  };
  const { client } = await ingest([otlp([http, toolsCall()])], {
    stripClientAddresses: () => true,
  });
  const { rows } = await client.query(
    `select harness, geo_country from otel_spans where span_id = $1`,
    [CALL],
  );
  assert.deepEqual(rows, [{ harness: "claude-code", geo_country: null }]);
  await client.close();
});
