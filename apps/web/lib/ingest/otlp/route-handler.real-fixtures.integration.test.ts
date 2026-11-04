import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
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
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { loadOtelFacts } from "@/lib/readings/trace-signals/signals/otel-facts-query";

/**
 * Real libraries' exports POSTed to the traces route, body by body as they
 * were sent, against a migrated database; then the turn build job over what
 * was stored. What the ledger holds is what the Agent health page reads.
 * Owned (ADR-0030): no plaintext key column, and no flag gate or organization
 * lookup on the turn build.
 */

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
};

function routeDeps(db: Db): TracesHandlerDeps {
  return {
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
    findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe, db),
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
  };
}

function buildDeps(db: Db): Partial<BuildJobDeps> {
  return {
    getCursor: (p) => getTraceTurnsCursor(p, db),
    listEvents: (p, since, _db, limit) => listTurnEventsPage(p, since, db, limit),
    listHits: (ids) => listTurnEventHits(ids, db),
    loadTurns: (p, sessions, keys, reach) => loadReloadableTurns(p, sessions, keys, reach, db),
    writePage: (input) => writeTurnPage(input, db),
    closeIdle: (p, before, now) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: async () => null,
    onBacklogDrained: async () => null,
    observability: { trackSystemEvent: async () => {} },
    salt: "test-salt",
  };
}

async function ingest(
  name: string,
  order: "sent" | "reversed" = "sent",
): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  const bodies = loadFixture(name);
  for (const body of order === "sent" ? bodies : [...bodies].reverse()) {
    const res = await handleTracesRequest(
      new Request("http://localhost/api/v1/traces", {
        method: "POST",
        headers: { "Content-Type": body.contentType, Authorization: "Bearer rtl_k" },
        body: Buffer.from(body.bytes),
      }),
      routeDeps(db),
    );
    assert.equal(res.status, 202, `${name} ${body.file}`);
  }
  const built = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db));
  assert.equal(built.outcome, "built");
  return { client, db };
}

interface StoredRun {
  key: string;
  session: string;
  tools: string;
}

async function runs(client: PGlite): Promise<StoredRun[]> {
  const result = await client.query<StoredRun>(`
    select t.turn_key as key, t.session_id as session,
      string_agg(s.target_id || case when s.outcome = 'error' then '!' else '' end, '>' order by s.ordinal) as tools
    from trace_turns t join trace_turn_steps s on s.turn_id = t.id
    where t.project_id = '${PROJECT_ID}'
    group by t.id, t.turn_key, t.session_id, t.started_at
    order by t.started_at, t.turn_key`);
  return result.rows;
}

async function count(client: PGlite, where: string): Promise<number> {
  const result = await client.query<{ n: number }>(
    `select count(*)::int as n from trace_events where project_id = '${PROJECT_ID}' and ${where}`,
  );
  return result.rows[0]?.n ?? 0;
}

const RUN_TOOLS = [
  "search_tasks>get_task>assign_task",
  "get_user>list_tasks",
  "find_board>archive_board!>notify",
];
const WINDOW = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") };

test("Vercel AI SDK: three runs with their tools, model calls and tokens, the agent span not counted", async () => {
  const { client, db } = await ingest("vercel-ai");
  const stored = await runs(client);
  assert.deepEqual(
    stored.map((r) => r.tools),
    RUN_TOOLS,
  );
  assert.ok(stored.every((r) => r.session === "sess-vercel-ai" && r.key.startsWith("otlp:")));
  assert.equal(await count(client, `type = 'otlp_model_call'`), 11);
  const facts = await loadOtelFacts(PROJECT_ID, WINDOW, db);
  const perRun = stored.map((r) => facts?.traces.get(r.key.slice("otlp:".length)));
  assert.deepEqual(
    perRun.map((f) => [f?.modelCalls, f?.inputTokens, f?.outputTokens]),
    [
      [4, 1040, 80],
      [3, 660, 60],
      [4, 1120, 80],
    ],
  );
  assert.ok(perRun.every((f) => f?.menus.size === 8));
  await client.close();
});

test("Vercel AI SDK: every stored model call keeps its trace and span id, and joins its run by trace", async () => {
  const { client } = await ingest("vercel-ai");
  const keys = new Set((await runs(client)).map((r) => r.key));
  const stored = await client.query<{ trace_id: string | null; span_id: string | null }>(
    `select trace_id, span_id from events where project_id = '${PROJECT_ID}'`,
  );
  assert.ok(stored.rows.length > 0);
  assert.ok(
    stored.rows.every((row) => row.trace_id && /^[0-9a-f]{32}$/.test(row.trace_id)),
    "a hex trace id on every row",
  );
  assert.ok(
    stored.rows.every((row) => row.span_id && /^[0-9a-f]{16}$/.test(row.span_id)),
    "a hex span id on every row",
  );
  assert.ok(
    stored.rows.every((row) => keys.has(`otlp:${row.trace_id}`)),
    "each joins a run through otlp:<trace id>",
  );
  assert.equal(
    new Set(stored.rows.map((row) => row.span_id)).size,
    stored.rows.length,
    "one row per model call span",
  );
  await client.close();
});

test("OpenAI Agents with the OpenAI client instrumented too: each call stored once", async () => {
  const { client } = await ingest("openai-agents-openinference-plus-openai");
  assert.deepEqual(
    (await runs(client)).map((r) => r.tools),
    RUN_TOOLS,
  );
  assert.equal(await count(client, `type = 'otlp_model_call'`), 11);
  await client.close();
});

for (const order of ["sent", "reversed"] as const) {
  test(`FastMCP client and server both exporting (${order}): every call stored once, runs per request`, async () => {
    const { client } = await ingest("mcp-python-fastmcp", order);
    assert.equal(await count(client, `type in ('invoke_end', 'invoke_error')`), 8);
    assert.deepEqual(
      (await runs(client)).map((r) => r.tools),
      RUN_TOOLS,
    );
    await client.close();
  });
}

test("an MCP server without trace context: calls of the MCP session grouped into a run", async () => {
  const { client } = await ingest("mcp-python-fastmcp-server-only");
  const stored = await runs(client);
  assert.equal(stored.length, 1);
  assert.ok(stored[0]!.key.startsWith("otlp-run:"));
  assert.equal(stored[0]!.session, "d28d1a5de2c1474693daef108e33e652");
  assert.equal(stored[0]!.tools, RUN_TOOLS.join(">"));
  await client.close();
});

test("an MCP server without trace context or session: one run per call", async () => {
  const { client } = await ingest("mcp-python-sdk-native-server-only");
  const stored = await runs(client);
  assert.equal(stored.length, 8);
  assert.ok(stored.every((r) => r.key === `otlp:${r.session}`));
  assert.equal(
    await count(client, `payload ->> 'root_tool' = 'true' and payload ->> 'has_session' = 'false'`),
    8,
  );
  await client.close();
});
