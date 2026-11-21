import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import type { PersistSpansDeps } from "../ingest-spans";
import { handleTracesRequest, type TracesHandlerDeps } from "../route-handler";

/**
 * Entity dimensions end to end (RC-772): OTLP exports POSTed to the traces
 * route against a migrated database, then the dimension columns read back
 * from `otel_spans`, and the MCP server of a tool row from `trace_events.server`.
 */

const FIXTURES = join(process.cwd(), "lib/ingest/otlp/__fixtures__/entity-dimensions");
const [SUPERVISOR, RESEARCHER, CHAT, TOOL, MCP_CLIENT, MCP_SERVER, SERVER_WORK] = [
  ..."1234567",
].map((d) => d.repeat(16));

const KEY: ApiKey = {
  id: "key-1",
  projectId: PROJECT_ID,
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: new Date(),
  revokedAt: null,
  expiresAt: null,
  scopes: ["*"],
  rateLimitPerMinute: null,
};

type RouteDeps = TracesHandlerDeps & Pick<PersistSpansDeps, "deriveSpanDimensions">;

function routeDeps(db: Db, overrides: Partial<RouteDeps> = {}): TracesHandlerDeps {
  // The route hands its deps to `persistDecodedSpans` whole, so a test's derivation reaches it.
  const deps: RouteDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertTraceEvents: (projectId, events) => insertTraceEvents(projectId, events, db),
    insertOtelSpans: (projectId, rows) => insertOtelSpans(projectId, rows, db),
    shouldSampleRejection: () => true,
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentSpanDedupe: {
      findTracesWithModelCalls: (projectId, traceIds) =>
        findTracesWithModelCalls(projectId, traceIds, db),
    },
    ...overrides,
  };
  return deps;
}

async function ingest(
  files: readonly string[],
  overrides: Partial<RouteDeps> = {},
): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  for (const file of files) {
    const res = await handleTracesRequest(
      new Request("http://localhost/api/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_k" },
        body: readFileSync(join(FIXTURES, file)),
      }),
      routeDeps(db, overrides),
    );
    assert.equal(res.status, 202, file);
  }
  return { client, db };
}

type Dimensions = [
  agentKey: string | null,
  agentSource: string | null,
  caller: string | null,
  server: string | null,
  serverSource: string | null,
  role: string | null,
  mcpSession: string | null,
];

async function spanDimensions(client: PGlite): Promise<Record<string, Dimensions>> {
  const { rows } = await client.query<Record<string, string | null>>(
    `select span_id, agent_key, agent_source, caller_agent_key, mcp_server, mcp_server_source, mcp_role, mcp_session_id from otel_spans`,
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.span_id,
      [
        r.agent_key,
        r.agent_source,
        r.caller_agent_key,
        r.mcp_server,
        r.mcp_server_source,
        r.mcp_role,
        r.mcp_session_id,
      ],
    ]),
  );
}

const EXPECTED: Record<string, Dimensions> = {
  [SUPERVISOR]: ["supervisor", "semconv", null, null, null, null, null],
  [RESEARCHER]: ["researcher", "semconv", "supervisor", null, null, null, null],
  [CHAT]: ["researcher", "semconv", "supervisor", null, null, null, null],
  // The tool name carries the server: `docs__search`.
  [TOOL]: ["researcher", "semconv", "supervisor", "docs", "heuristic", "consumed", null],
  // The MCP client span knows the call and its transport session, not the server's name.
  [MCP_CLIENT]: ["researcher", "semconv", "supervisor", null, null, "consumed", "sess-docs-1"],
  // The server's side: its service is the server, and no agent.
  [MCP_SERVER]: [null, null, null, "docs-mcp", "semconv", "provided", "sess-docs-1"],
  [SERVER_WORK]: [null, null, null, null, null, null, null],
};

test("two nested agents and an MCP server span get their dimensions in otel_spans", async () => {
  const { client } = await ingest(["agent.otlp.json", "mcp-server.otlp.json"]);
  assert.deepEqual(await spanDimensions(client), EXPECTED);
  await client.close();
});

test("the dimensions are the same when the server's export comes first", async () => {
  const { client } = await ingest(["mcp-server.otlp.json", "agent.otlp.json"]);
  assert.deepEqual(await spanDimensions(client), EXPECTED);
  await client.close();
});

test("the MCP tool row names its server in trace_events.server; the other derived rows keep it null", async () => {
  const { client } = await ingest(["agent.otlp.json", "mcp-server.otlp.json"]);
  const { rows } = await client.query(
    `select type, span_id, tool_id, server, payload ->> 'agent' as payload_agent
     from trace_events where ingest_source = 'otlp' order by type, span_id`,
  );
  assert.deepEqual(rows, [
    // One row for the call: the client's tool span. The server's row has the same id and is not stored again.
    {
      type: "invoke_end",
      span_id: TOOL,
      tool_id: "docs__search",
      server: "docs",
      payload_agent: "researcher",
    },
    {
      type: "otlp_model_call",
      span_id: CHAT,
      tool_id: null,
      server: null,
      payload_agent: "researcher",
    },
  ]);
  await client.close();
});

test("an MCP server that exports alone stores its call with its own name as the server", async () => {
  const { client } = await ingest(["mcp-server.otlp.json"]);
  const { rows } = await client.query(
    `select type, span_id, tool_id, source_id, server, payload ? 'agent' as has_agent from trace_events where ingest_source = 'otlp'`,
  );
  assert.deepEqual(rows, [
    {
      type: "invoke_end",
      span_id: MCP_SERVER,
      tool_id: "search",
      source_id: "docs-mcp",
      server: "docs-mcp",
      has_agent: false,
    },
  ]);
  await client.close();
});

test("trace_events has no entity dimension column: the dimensions live on otel_spans", async () => {
  const { client } = await ingest([]);
  const { rows } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'trace_events'
     and column_name in ('agent_key', 'agent_source', 'mcp_server', 'mcp_server_source', 'mcp_role')`,
  );
  assert.deepEqual(rows, []);
  await client.close();
});

test("a derivation that throws is logged, and the batch is still stored: null dimensions, the payload agent of main (RC-811)", async () => {
  const logged: string[] = [];
  let calls = 0;
  const { client } = await ingest(["agent.otlp.json", "mcp-server.otlp.json"], {
    deriveSpanDimensions: () => {
      calls += 1;
      throw new Error("derivation failed");
    },
    logError: (message, err) =>
      logged.push(`${message}: ${err instanceof Error ? err.message : String(err)}`),
  });
  assert.deepEqual(
    logged,
    Array(2).fill("span dimension derivation failed: derivation failed"),
    "logged one time per export",
  );
  assert.equal(calls, 2, "derived one time per export: no builder derives again");

  const spans = await spanDimensions(client);
  assert.deepEqual(Object.keys(spans).sort(), Object.keys(EXPECTED).sort(), "every span is stored");
  for (const dimensions of Object.values(spans))
    assert.deepEqual(dimensions, [null, null, null, null, null, null, null]);

  const { rows } = await client.query(
    `select type, span_id, tool_id, server, payload ->> 'agent' as payload_agent
     from trace_events where ingest_source = 'otlp' order by type, span_id`,
  );
  assert.deepEqual(rows, [
    {
      type: "invoke_end",
      span_id: TOOL,
      tool_id: "docs__search",
      server: null,
      payload_agent: "researcher",
    },
    {
      type: "otlp_model_call",
      span_id: CHAT,
      tool_id: null,
      server: null,
      payload_agent: "researcher",
    },
  ]);
  const { rows: events } = await client.query<{ n: number }>(
    `select count(*)::int as n from events`,
  );
  assert.equal(events[0]!.n, 1, "the model call's events row is stored too");
  await client.close();
});
