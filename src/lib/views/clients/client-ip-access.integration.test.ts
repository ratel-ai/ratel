import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ingest, otlp, type SpanSpec } from "@/lib/ingest/otlp/dimensions/client-facts-support";
import { mmdbGeoLookup } from "@/lib/ingest/otlp/dimensions/geo";
import { toOtelLogRows } from "@/lib/ingest/otlp/log-rows";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { clientsOperations } from "@/lib/mcp/operations/clients";
import {
  defaultObservabilityDeps,
  observabilityOperations,
} from "@/lib/mcp/operations/observability";
import { runsOperations } from "@/lib/mcp/operations/runs";
import { buildRegistry } from "@/lib/mcp/registry";
import { PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import { listProjectEvents } from "@/lib/synthesis/traces/events-queries";
import {
  getTraceAggregates,
  getTraceSpans,
  getTraceSpansWithTruncation,
  listSpans,
  listTraceLifecycleEvents,
} from "@/lib/synthesis/traces/queries";
import { toTraceSpanView } from "@/lib/synthesis/traces/view";
import { getClientsOverview } from "@/lib/views/clients/queries";

/**
 * The core never stores a caller's IP (RP-138, the owner's decision, in place
 * of upstream's admin-only `client_ip`, RC-778): ingest reads the IP's country
 * (`geo_country`) and drops the IP. No column holds it, and no source key of it
 * stays in `attributes` or `otel_logs`. This proves, against a migrated database:
 * - `otel_spans` has no `client_ip` column, and the country is stored;
 * - the span loader every page reads gives no reader, admin or member, the IP;
 * - the MCP tools that read spans and logs (get_trace, get_span, list_spans,
 *   list_logs, list_clients) never return it;
 * - no source file names a client IP column or field outside ingest's
 *   in-memory derivation (a static guard).
 * The raw trace route's own test covers `otlp_raw_exports`
 * (`ingest/otlp-raw/trace-raw-route.test.ts`).
 */

const IP = "81.2.69.160";
const TRACE = "a".repeat(32);
const [HTTP, CALL] = ["1".repeat(16), "2".repeat(16)];
const GEO = mmdbGeoLookup(
  readFileSync(join(process.cwd(), "lib/ingest/otlp/__fixtures__/geo/GeoIP2-Country-Test.mmdb")),
);
const NOW = new Date("2026-11-17T12:00:00.000Z");

const SPANS: SpanSpec[] = [
  {
    traceId: TRACE,
    spanId: HTTP,
    name: "POST /mcp",
    kind: 2,
    startMs: 0,
    endMs: 50,
    attributes: {
      "http.request.method": "POST",
      "user_agent.original": "claude-code/2.1.3",
      "client.address": IP,
      "net.peer.ip": IP,
      "network.peer.address": IP,
      "http.request.header.x-forwarded-for": IP,
    },
  },
  {
    traceId: TRACE,
    spanId: CALL,
    parentSpanId: HTTP,
    name: "tools/call get_forecast",
    kind: 2,
    startMs: 5,
    endMs: 40,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_forecast",
      "client.address": IP,
    },
  },
];

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT_ID,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

async function seeded() {
  const seeded = await ingest([otlp(SPANS)], { geo: GEO });
  const { rows: columns } = await seeded.client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'otel_spans'`,
  );
  assert.equal(
    columns.some((row) => /ip|address/i.test(row.column_name)),
    false,
    "no otel_spans column holds a caller's IP",
  );
  const { rows } = await seeded.client.query<{ geo_country: string | null }>(
    `select geo_country from otel_spans where span_id = $1`,
    [CALL],
  );
  assert.equal(rows[0]?.geo_country, "GB", "ingest stores the IP's country");
  const { rows: attrs } = await seeded.client.query<{ attributes: unknown }>(
    `select attributes from otel_spans`,
  );
  assert.equal(
    JSON.stringify(attrs).includes(IP),
    false,
    "no source key of the IP is kept in attributes",
  );
  return seeded;
}

test("the span loader gives no reader the IP, only its country", async () => {
  const { client, db } = await seeded();
  const load = await getTraceSpansWithTruncation(PROJECT_ID, TRACE, db);
  assert.equal(load.spans.length, 2);
  assert.equal(JSON.stringify(load.spans).includes(IP), false);
  assert.equal(JSON.stringify(load.spans.map(toTraceSpanView)).includes(IP), false);
  assert.equal(JSON.stringify(await getTraceSpans(PROJECT_ID, TRACE, db)).includes(IP), false);
  const call = load.spans.find((span) => span.spanId === CALL);
  assert.equal(call?.geoCountry, "GB", "the country is for every member");
  await client.close();
});

test("no MCP tool that reads spans, logs or clients returns the raw IP", async () => {
  const { client, db } = await seeded();
  const log = toOtelLogRows(PROJECT_ID, [
    {
      eventName: "ratel.search",
      timeUnixNano: `${Date.parse("2026-11-17T10:00:00Z")}000000`,
      timeUnixMs: Date.parse("2026-11-17T10:00:00Z"),
      observedTimeUnixNano: `${Date.parse("2026-11-17T10:00:00Z")}000000`,
      observedTimeUnixMs: Date.parse("2026-11-17T10:00:00Z"),
      traceId: TRACE,
      spanId: CALL,
      severityNumber: 9,
      severityText: "INFO",
      body: "search",
      attributes: { "client.address": IP, "net.peer.ip": IP, "ratel.search.query": "rome" },
      resourceAttributes: { "service.name": "weather-mcp", "client.address": IP },
      scopeName: "ratel",
    },
  ]);
  assert.equal(log.rows.length, 1);
  await insertOtelLogs(PROJECT_ID, log.rows, db);

  const registry = buildRegistry([
    ...runsOperations({
      getTraceSpansWithTruncation: (projectId, traceId) =>
        getTraceSpansWithTruncation(projectId, traceId, db),
      listTraceLifecycleEvents: (projectId, traceId) =>
        listTraceLifecycleEvents(projectId, traceId, db),
      listSpans: (projectId, options) => listSpans(projectId, options, db),
      listProjectEvents: (projectId, options) => listProjectEvents(projectId, options, db),
      getTraceAggregates: (projectId, options) => getTraceAggregates(projectId, options, db),
      loadTurnDetail: async () => null,
      agentHealthEnabled: async () => true,
      loadPayloadContent: async () => null,
      contentOptIn: async () => true,
      loadTraceSessionChat: async () => null,
    }),
    ...observabilityOperations({
      ...defaultObservabilityDeps,
      getTraceSpansWithTruncation: (projectId, traceId) =>
        getTraceSpansWithTruncation(projectId, traceId, db),
      contentOptIn: async () => true,
    }),
    ...clientsOperations({
      getClientsOverview: (projectId, window) => getClientsOverview(projectId, window, db),
      now: () => NOW,
    }),
  ]);
  const window = { since: "2026-11-01T00:00:00Z", until: "2026-12-01T00:00:00Z" };
  const calls: Array<[string, Record<string, unknown>]> = [
    ["get_trace", { traceId: TRACE }],
    ["get_span", { traceId: TRACE, spanId: CALL }],
    ["list_spans", window],
    ["list_logs", window],
    ["list_clients", window],
  ];
  for (const [id, params] of calls) {
    const result = await dispatchOperation(id, params, { registry, auth });
    assert.ok(result.ok, `${id}: ${JSON.stringify(result)}`);
    const body = JSON.stringify(result);
    assert.equal(body.includes(IP), false, `${id} returned the raw IP`);
    assert.equal(/client_?ip/i.test(body), false, `${id} names a client IP field`);
  }
  await client.close();
});

/**
 * The files that may name the in-memory IP field: the derivation that reads its country, and the
 * session store that gives a stored session none. No file may name a `client_ip` column.
 */
const CLIENT_IP_FIELD_ALLOWED = new Set([
  "lib/ingest/otlp/dimensions/client.ts",
  "lib/ingest/otlp/client-session-store.ts",
]);
const SOURCE_ROOTS = ["lib", "app", "components"];
const IP_FIELD = /\bclientIp\b/;

test("no source file names a client_ip column, and only ingest's derivation names the IP field", () => {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(process.cwd(), root))) {
      const path = relative(process.cwd(), file);
      if (
        /\.test\.tsx?$/.test(path) ||
        path.includes("__fixtures__") ||
        path.endsWith("-support.ts")
      )
        continue;
      const text = withoutComments(readFileSync(file, "utf8"));
      // The column, not an OTel key such as `http.client_ip`.
      if (/(?<![.\w])client_ip\b/.test(text)) offenders.push(`${path}: client_ip`);
      // The IP stays in ingest's memory: no row, loader or page carries it.
      if (IP_FIELD.test(text) && !CLIENT_IP_FIELD_ALLOWED.has(path))
        offenders.push(`${path}: clientIp`);
    }
  }
  assert.deepEqual(offenders, []);
});

function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
    .join("\n");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
