import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QUERY_VERSION } from "@/lib/contracts/query";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { RQL_TABLES } from "@/lib/synthesis/rql/domain/catalog";
import { usageKey } from "@/lib/synthesis/rql/domain/usage";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { loadCompletionUsage, MAX_SAVED_QUERIES } from "./completion-usage";

/**
 * What the RQL field of one project ranks by (decision `completion-ranking`): the names its saved
 * widgets and alert rules use, and the columns that hold data in its newest rows. Never another
 * project's, and bounded.
 */

const OTHER = "33333333-3333-4333-8333-333333333333";

const widget = (text: string) => ({
  id: crypto.randomUUID(),
  title: "",
  chart: "number",
  query: { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
});

async function seeded() {
  const setup = await setupDb();
  await setup.client.exec(`
    insert into projects (id, organization_id, name, slug)
    values ('${OTHER}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
  `);
  const dashboard = (project: string, widgets: unknown[]) =>
    setup.client.query(
      `insert into dashboards (project_id, name, widgets, updated_by) values ($1, 'D', $2::jsonb, 'u')`,
      [project, JSON.stringify(widgets)],
    );
  await dashboard(PROJECT_ID, [
    widget("select sum(cost_usd) from traces"),
    // A widget of another kind has no RQL text.
    { id: crypto.randomUUID(), title: "", chart: "line", query: { version: 1, kind: "trace" } },
  ]);
  await dashboard(OTHER, [
    widget("select count(*) from traces where properties['secret_plan'] = 'x'"),
  ]);
  await setup.client.query(
    `insert into alert_rules (project_id, name, query, operator, threshold, window_minutes, created_by, updated_by)
     values ($1, 'A', $2::jsonb, 'above', 1, 60, 'u', 'u')`,
    [
      PROJECT_ID,
      JSON.stringify(widget("select avg(duration_ms) from traces where has_error").query),
    ],
  );
  return setup;
}

/** A sampler that answers from fixed rows, by the table its text reads. */
function sampler(rows: Record<string, { columns: string[]; rows: unknown[][] }>) {
  const asked: { projectId: string; text: string }[] = [];
  return {
    asked,
    sample: async (projectId: string, text: string) => {
      asked.push({ projectId, text });
      const table = /from (\w+)/.exec(text)?.[1] ?? "";
      const found = rows[table];
      if (!found) throw new Error("not read");
      return {
        columns: found.columns.map((name) => ({ name, type: "text" })),
        rows: found.rows,
      };
    },
  };
}

test("the usage of a project: its saved widgets and alert rules, and the columns of its newest rows that hold data", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  const { sample, asked } = sampler({
    traces: {
      columns: ["trace_id", "session_id", "cost_usd", "tools"],
      rows: [
        ["t1", null, 0, []],
        ["t2", "", 0.5, []],
      ],
    },
  });
  const usage = await loadCompletionUsage(PROJECT_ID, { db, sample });
  assert.equal(usage.uses[usageKey("column", "cost_usd")], 1);
  assert.equal(usage.uses[usageKey("column", "duration_ms")], 1);
  assert.equal(usage.uses[usageKey("table", "traces")], 2);
  // A table whose read failed is not known: it is not in the map.
  assert.equal(usage.columnsWithData.events, undefined);
  // A zero is data; a null, an empty text and an empty list are not.
  assert.deepEqual(usage.columnsWithData, { traces: ["trace_id", "cost_usd"] });
  assert.equal(usage.propertiesWithData, null);
  // Each read is of this project, one bounded read per table.
  assert.ok(asked.every(({ projectId }) => projectId === PROJECT_ID));
  assert.ok(asked.every(({ text }) => /limit \d+$/.test(text)));
});

test("the saved queries and property names of one project do not reach another", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  const { sample } = sampler({});
  const own = await loadCompletionUsage(PROJECT_ID, { db, sample });
  const other = await loadCompletionUsage(OTHER, { db, sample });
  assert.equal(own.uses[usageKey("property", "secret_plan")], undefined);
  assert.ok(!JSON.stringify(own).includes("secret_plan"));
  assert.equal(other.uses[usageKey("property", "secret_plan")], 1);
  assert.equal(other.uses[usageKey("column", "cost_usd")], undefined);
  // A project with no saved query has no history.
  const none = await loadCompletionUsage("44444444-4444-4444-8444-444444444444", { db, sample });
  assert.deepEqual([none.uses, none.together], [{}, {}]);
});

test("by default the columns are read through RQL, for this project only", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  const executor = createPgRqlExecutor(pglitePoolOf(client));
  const now = new Date("2026-11-27T12:00:00Z");
  const trace = (project: string, id: string, session: string | null) =>
    client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, session_id)
       values ($1, $2, '2026-11-26T10:00:00Z', 10, false, 0, 0, 0, now(), now(), $3)`,
      [project, id, session],
    );
  await trace(PROJECT_ID, "t1", null);
  await trace(OTHER, "o1", "s-1");
  const run = { executor, gate: createRqlGate() };
  const own = await loadCompletionUsage(PROJECT_ID, { db, now, run });
  const other = await loadCompletionUsage(OTHER, { db, now, run });
  assert.ok(own.columnsWithData.traces?.includes("duration_ms"));
  assert.ok(!own.columnsWithData.traces?.includes("session_id"));
  assert.ok(other.columnsWithData.traces?.includes("session_id"));
  // A project with no rows: every table read, no column with data.
  const none = await loadCompletionUsage("44444444-4444-4444-8444-444444444444", {
    db,
    now,
    run,
  });
  assert.deepEqual(none.columnsWithData.traces, []);
});

test("the sample never waits for a console place: a busy project keeps its start order", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  let waited = 0;
  const busy = {
    enter: () => undefined,
    wait: async () => {
      waited += 1;
      return undefined;
    },
  };
  const usage = await loadCompletionUsage(PROJECT_ID, {
    db,
    run: { executor: createPgRqlExecutor(pglitePoolOf(client)), gate: busy },
  });
  assert.deepEqual(usage.columnsWithData, {});
  // The saved queries still count.
  assert.equal(usage.uses[usageKey("column", "cost_usd")], 1);
  // One try per table, and no wait: the gate answers at once.
  assert.equal(waited, RQL_TABLES.length);
});

test("the read is bounded: at most MAX_SAVED_QUERIES texts, the newest first", async () => {
  const { client, db } = await seeded();
  after(() => client.close());
  const many = Array.from({ length: MAX_SAVED_QUERIES + 50 }, () =>
    widget("select max(input_tokens) from traces"),
  );
  await client.query(
    `insert into dashboards (project_id, name, widgets, updated_by, updated_at) values ($1, 'Many', $2::jsonb, 'u', now() + interval '1 day')`,
    [PROJECT_ID, JSON.stringify(many)],
  );
  const usage = await loadCompletionUsage(PROJECT_ID, { db, sample: sampler({}).sample });
  assert.equal(usage.uses[usageKey("function", "max")], MAX_SAVED_QUERIES);
  assert.equal(usage.uses[usageKey("function", "sum")], undefined);
});
