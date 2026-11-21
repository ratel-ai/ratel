import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deriveSpanDimensions } from "@/lib/ingest/otlp/dimensions";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { indexSpans } from "../attr-resolve";
import { toOtelSpanRows } from "../span-rows";
import type { AttrMap, DecodedSpan } from "../types";
import {
  backfillEntityDimensions,
  backfillOptionsFromArgs,
  type EntityDimensionsBackfillDb,
} from "./backfill";

/**
 * The backfill against a real schema: spans stored before migration 0106 (no
 * dimension column) get the values ingest gives the same spans.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = 1_750_000_000_000;

type TestDb = EntityDimensionsBackfillDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

function span(
  traceId: string,
  spanId: string,
  over: Partial<DecodedSpan> & { attributes?: AttrMap } = {},
): DecodedSpan {
  return {
    traceId: traceId.repeat(32),
    spanId: spanId.repeat(16),
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: T0,
    endUnixMs: T0 + 10,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "pm-service" },
    scopeName: null,
    ...over,
  };
}

/** Three traces: nested agents with a tool call, an MCP server's own trace, and a trace with no agent. */
const SPANS: DecodedSpan[] = [
  span("a", "1", {
    name: "invoke_agent supervisor",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "supervisor" },
  }),
  span("a", "2", {
    parentSpanId: "1".repeat(16),
    name: "invoke_agent researcher",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" },
  }),
  span("a", "3", {
    parentSpanId: "2".repeat(16),
    name: "execute_tool github__search",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "github__search" },
  }),
  span("b", "4", {
    kind: 2,
    name: "tools/call find_task",
    resourceAttributes: { "service.name": "tasks-mcp" },
  }),
  span("c", "5", { name: "chat", attributes: { "gen_ai.operation.name": "chat" } }),
];

const COLUMNS =
  "agent_key, agent_source, caller_agent_key, mcp_server, mcp_server_source, mcp_role";

async function setup(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const dimensions = deriveSpanDimensions(SPANS, indexSpans(SPANS));
  await insertOtelSpans(
    PROJECT_ID,
    toOtelSpanRows(PROJECT_ID, SPANS, undefined, { dimensions }),
    db,
  );
  return { client, db };
}

async function stored(client: PGlite): Promise<unknown[]> {
  const { rows } = await client.query(
    `select span_id, ${COLUMNS} from otel_spans order by span_id`,
  );
  return rows;
}

/** The rows as they were before migration 0106. */
async function forgetDimensions(client: PGlite): Promise<void> {
  await client.exec(`update otel_spans set agent_key = null, agent_source = null, caller_agent_key = null,
    mcp_server = null, mcp_server_source = null, mcp_role = null`);
}

test("the backfill gives stored spans the values ingest gives them, in batches, and a second run writes nothing", async () => {
  const { client, db } = await setup();
  const atIngest = await stored(client);
  await forgetDimensions(client);
  const received = await client.query(
    `select span_id, received_at from otel_spans order by span_id`,
  );

  const batches: number[] = [];
  const first = await backfillEntityDimensions(db, {
    apply: true,
    batchSize: 2,
    onBatch: (p) => batches.push(p.traces),
  });
  assert.deepEqual(first, { traces: 3, spans: 5, batches: 2 });
  assert.deepEqual(batches, [2, 3], "two traces, then the third");
  assert.deepEqual(await stored(client), atIngest);
  assert.deepEqual(
    (await stored(client)).find((row) => (row as { span_id: string }).span_id === "3".repeat(16)),
    {
      span_id: "3".repeat(16),
      agent_key: "researcher",
      agent_source: "semconv",
      caller_agent_key: "supervisor",
      mcp_server: "github",
      mcp_server_source: "heuristic",
      mcp_role: "consumed",
    },
  );
  assert.deepEqual(
    (await client.query(`select span_id, received_at from otel_spans order by span_id`)).rows,
    received.rows,
    "received_at is kept, so the summary sweep cursor does not move",
  );

  const second = await backfillEntityDimensions(db, { apply: true, batchSize: 2 });
  assert.deepEqual(second, { traces: 0, spans: 0, batches: 0 }, "nothing is left to fill");
  await client.close();
});

test("without apply it is a dry run that counts and writes nothing; a span that already has its dimensions is not rewritten", async () => {
  const { client, db } = await setup();
  await forgetDimensions(client);
  // Ingest read an attribute the stored row does not keep: its value stays.
  await client.exec(
    `update otel_spans set agent_key = 'from-ingest', agent_source = 'semconv' where span_id = '${"5".repeat(16)}'`,
  );

  const dry = await backfillEntityDimensions(db, {});
  assert.deepEqual(dry, { traces: 2, spans: 4, batches: 1 });
  const { rows: untouched } = await client.query(
    `select count(*)::int as n from otel_spans where agent_key is null and mcp_role is null`,
  );
  assert.equal((untouched[0] as { n: number }).n, 4);

  await backfillEntityDimensions(db, { apply: true });
  const { rows } = await client.query(
    `select agent_key, agent_source from otel_spans where span_id = '${"5".repeat(16)}'`,
  );
  assert.deepEqual(rows, [{ agent_key: "from-ingest", agent_source: "semconv" }]);
  await client.close();
});

test("the backfill reads one project when asked, and only spans received before the cut", async () => {
  const { client, db } = await setup();
  await forgetDimensions(client);
  const other = await backfillEntityDimensions(db, { apply: true, projectId: ORGANIZATION_ID });
  assert.deepEqual(other, { traces: 0, spans: 0, batches: 0 });
  const early = await backfillEntityDimensions(db, {
    apply: true,
    before: new Date("2020-01-01T00:00:00Z"),
  });
  assert.deepEqual(early, { traces: 0, spans: 0, batches: 0 });
  const mine = await backfillEntityDimensions(db, { apply: true, projectId: PROJECT_ID });
  assert.equal(mine.spans, 5);
  await client.close();
});

test("the script's arguments: no flag is a dry run that writes nothing and reports counts; --apply writes (RC-811)", async () => {
  const { client, db } = await setup();
  await forgetDimensions(client);
  const empty = async () => {
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from otel_spans where agent_key is null and mcp_role is null`,
    );
    return rows[0]!.n;
  };

  const noFlag = backfillOptionsFromArgs([]);
  assert.equal(noFlag.apply, false);
  assert.deepEqual(await backfillEntityDimensions(db, noFlag), { traces: 3, spans: 5, batches: 1 });
  assert.equal(await empty(), 5, "nothing was written: all five spans are still empty");

  assert.equal(
    backfillOptionsFromArgs(["--dry-run"]).apply,
    false,
    "--dry-run is the default, said aloud",
  );
  assert.equal(await empty(), 5);

  const applied = backfillOptionsFromArgs([
    "--apply",
    "--batch-size",
    "2",
    "--project",
    PROJECT_ID,
  ]);
  assert.deepEqual(
    { apply: applied.apply, batchSize: applied.batchSize, projectId: applied.projectId },
    { apply: true, batchSize: 2, projectId: PROJECT_ID },
  );
  assert.deepEqual(await backfillEntityDimensions(db, applied), {
    traces: 3,
    spans: 5,
    batches: 2,
  });
  assert.equal(await empty(), 0);

  assert.throws(() => backfillOptionsFromArgs(["--apply", "--dry-run"]), /cannot go together/);
  assert.throws(() => backfillOptionsFromArgs(["--batch-size", "0"]), /positive integer/);
  assert.throws(() => backfillOptionsFromArgs(["--before", "soon"]), /ISO time/);
  assert.throws(() => backfillOptionsFromArgs(["--project"]), /needs a value/);
  await client.close();
});
