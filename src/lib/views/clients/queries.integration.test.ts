import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ingest, otlp, type SpanSpec } from "@/lib/ingest/otlp/dimensions/client-facts-support";
import { mmdbGeoLookup } from "@/lib/ingest/otlp/dimensions/geo";
import { type Db, PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import {
  type ClientsWindow,
  clientFacetsQuery,
  clientOptionsQuery,
  countriesQuery,
  getClientsOverview,
  harnessesQuery,
  harnessVersionsQuery,
} from "./queries";

/**
 * The Clients tab's reads (RC-778) over real exports: the TS MCP SDK over HTTP
 * from two harnesses, the Python MCP SDK over stdio (no client), and one call
 * from a public IP the test geo file knows.
 */

const REAL = join(process.cwd(), "lib/ingest/otlp/__fixtures__/client-facts");
const GEO = mmdbGeoLookup(
  readFileSync(join(process.cwd(), "lib/ingest/otlp/__fixtures__/geo/GeoIP2-Country-Test.mmdb")),
);
const WINDOW: ClientsWindow = {
  since: new Date("2026-11-01T00:00:00Z"),
  until: new Date("2026-12-01T00:00:00Z"),
};
const SERVER = 2;

const codexCall: SpanSpec[] = [
  {
    traceId: "d".repeat(32),
    spanId: "1".repeat(16),
    name: "POST",
    kind: SERVER,
    startMs: 0,
    endMs: 40,
    attributes: {
      "http.request.method": "POST",
      "user_agent.original": "codex_cli_rs/0.50.0",
      "client.address": "81.2.69.160",
    },
  },
  {
    traceId: "d".repeat(32),
    spanId: "2".repeat(16),
    parentSpanId: "1".repeat(16),
    name: "tools/call get_forecast",
    kind: SERVER,
    startMs: 5,
    endMs: 30,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "get_forecast",
      "network.transport": "tcp",
      "error.type": "tool_error",
    },
  },
];

async function seeded(): Promise<{ client: PGlite; db: Db }> {
  return ingest(
    [
      ...["claude-code", "cursor"].flatMap((h) => [
        `ts-http-${h}-initialize`,
        `ts-http-${h}-tools-call`,
      ]),
      "py-stdio-codex-initialize",
      "py-stdio-codex-tools-call",
    ]
      .map((name) => readFileSync(join(REAL, `${name}.otlp.json`), "utf8"))
      .concat(otlp(codexCall)),
    { geo: GEO },
  );
}

test("harnesses, versions, countries, transports and protocol versions of the window's provided MCP calls", async () => {
  const { client, db } = await seeded();
  const overview = await getClientsOverview(PROJECT_ID, WINDOW, db);

  assert.deepEqual(
    overview.harnesses.map(({ harness, calls, errors, sessions }) => ({
      harness,
      calls,
      errors,
      sessions,
    })),
    [
      { harness: null, calls: 4, errors: 0, sessions: 4 },
      { harness: "claude-code", calls: 3, errors: 0, sessions: 1 },
      { harness: "cursor", calls: 3, errors: 0, sessions: 1 },
      { harness: "codex", calls: 1, errors: 1, sessions: 1 },
    ],
  );
  assert.equal(overview.harnesses.find((row) => row.harness === "codex")?.errorRate, 1);
  // RC-779: the real TS SDK exports name no client, so each harness is a User-Agent guess.
  assert.deepEqual(
    overview.harnesses.map(({ harness, detection }) => ({ harness, detection })),
    [
      { harness: null, detection: null },
      { harness: "claude-code", detection: { source: "heuristic", rule: "user-agent" } },
      { harness: "cursor", detection: { source: "heuristic", rule: "user-agent" } },
      { harness: "codex", detection: { source: "heuristic", rule: "user-agent" } },
    ],
  );
  assert.deepEqual(
    overview.versions.map(({ harness, version, calls }) => ({ harness, version, calls })),
    [
      { harness: "claude-code", version: "2.1.3", calls: 3 },
      { harness: "codex", version: "0.50.0", calls: 1 },
      { harness: "cursor", version: "1.7.0", calls: 3 },
      { harness: null, version: null, calls: 4 },
    ],
  );
  assert.deepEqual(overview.countries, [
    { country: null, calls: 10, sessions: 6 },
    { country: "GB", calls: 1, sessions: 1 },
  ]);
  assert.deepEqual(overview.transports, [
    { value: "http", calls: 7 },
    { value: null, calls: 4 },
  ]);
  assert.deepEqual(overview.protocolVersions, [
    { value: "2025-11-25", calls: 10 },
    { value: null, calls: 1 },
  ]);
  assert.deepEqual(overview.servers, ["notes-mcp", "weather-mcp"]);
  assert.deepEqual(overview.environments, []);
  await client.close();
});

test("the server filter narrows the stats; the options stay the window's", async () => {
  const { client, db } = await seeded();
  const overview = await getClientsOverview(PROJECT_ID, { ...WINDOW, server: "notes-mcp" }, db);
  assert.deepEqual(
    overview.harnesses.map((row) => [row.harness, row.calls]),
    [[null, 4]],
  );
  assert.deepEqual(overview.servers, ["notes-mcp", "weather-mcp"]);
  const empty = await getClientsOverview(
    PROJECT_ID,
    { ...WINDOW, since: new Date("2027-01-01"), until: new Date("2027-02-01") },
    db,
  );
  assert.deepEqual(empty.harnesses, []);
  await client.close();
});

test("no query selects the caller's raw IP", () => {
  const dialect = new PgDialect();
  for (const query of [
    harnessesQuery,
    harnessVersionsQuery,
    countriesQuery,
    clientFacetsQuery,
    clientOptionsQuery,
  ]) {
    const text = dialect.sqlToQuery(query(PROJECT_ID, WINDOW) as SQL).sql;
    assert.equal(text.includes("client_ip"), false, query.name);
  }
});

test("every query reads the MCP server partial index within the window", async () => {
  const { client } = await seeded();
  await client.exec("set enable_seqscan = off");
  const dialect = new PgDialect();
  for (const query of [
    harnessesQuery,
    harnessVersionsQuery,
    countriesQuery,
    clientFacetsQuery,
    clientOptionsQuery,
  ]) {
    const { sql, params } = dialect.sqlToQuery(query(PROJECT_ID, WINDOW) as SQL);
    const { rows } = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, params);
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /otel_spans_project_mcp_server_started_idx/, `${query.name}\n${plan}`);
  }
  await client.close();
});
