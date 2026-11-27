import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { metricQuery } from "@/lib/contracts/query";
import { runMigrations } from "@/lib/platform/db/migrate";
import * as schema from "@/lib/platform/db/tables";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { compacted, freePosition } from "@/lib/views/dashboards/layout";
import {
  changeWidgets,
  countDashboards,
  createDashboard,
  type DashboardsDb,
  deleteDashboard,
  getDashboard,
  updateDashboard,
} from "@/lib/views/dashboards/store";
import { MAX_DASHBOARDS } from "@/lib/views/dashboards/types";

/**
 * Two transactions that overlap need two connections, which PGlite does not have. With
 * TEST_POSTGRES_URL (a server where a database may be created) this runs on a database of its own.
 */
const server = process.env.TEST_POSTGRES_URL;
const DATABASE = `ratel_dashboards_${process.pid}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FULL = "44444444-4444-4444-8444-444444444444";
const BY = { updatedBy: "u", updatedByName: "Ada" };

let pool: Pool;

before(async () => {
  if (!server) return;
  await asAdmin(`create database ${DATABASE}`);
  const url = new URL(server);
  url.pathname = `/${DATABASE}`;
  await runMigrations({ url: url.href, sslMode: "disable" });
  pool = new Pool({ connectionString: url.href });
  await pool.query(
    `insert into projects (id, organization_id, name, slug) values ($1, $1, 'Agent', 'agent'), ($2, $2, 'Full', 'full')`,
    [PROJECT, FULL],
  );
});

after(async () => {
  if (!server) return;
  await pool.end();
  await asAdmin(`drop database ${DATABASE}`);
});

test("two overlapping transactions lose no widget", { skip: !server }, async () => {
  const db = drizzle(pool, { schema }) as unknown as DashboardsDb;
  const made = await createDashboard(
    { projectId: PROJECT, name: "Board", widgets: [widget("a", 0), widget("b", 6)], ...BY },
    db,
  );
  assert.ok(made);
  const { id } = made;
  // Both start while a third connection holds the row, so each is open before the other ends.
  const holder = await pool.connect();
  await holder.query("begin");
  await holder.query("select 1 from dashboards where id = $1 for update", [id]);
  const adds = changeWidgets(
    {
      projectId: PROJECT,
      id,
      change: (widgets) => [...widgets, { ...widget("new", 0), layout: freePosition(widgets) }],
      ...BY,
    },
    db,
  );
  const places = changeWidgets(
    {
      projectId: PROJECT,
      id,
      change: (widgets) =>
        compacted(
          widgets.map((item) =>
            item.id === "a" ? { ...item, layout: { x: 0, y: 0, w: 12, h: 8 } } : item,
          ),
        ),
      ...BY,
    },
    db,
  );
  await until(async () => (await waiting()) === 2);
  await holder.query("commit");
  holder.release();
  assert.deepEqual(await Promise.all([adds, places]), ["changed", "changed"]);

  const stored = (await getDashboard(PROJECT, id, db))?.widgets ?? [];
  assert.deepEqual(stored.map((item) => item.id).sort(), ["a", "b", "new"]);
  assert.deepEqual(stored.find((item) => item.id === "a")?.layout, { x: 0, y: 0, w: 12, h: 8 });
});

test("creates at the same time never pass the limit of dashboards", { skip: !server }, async () => {
  const db = drizzle(pool, { schema }) as unknown as DashboardsDb;
  await pool.query(
    `insert into dashboards (project_id, name, widgets, updated_by, updated_by_name)
     select $1, 'd' || g, '[]'::jsonb, 'u', 'Ada' from generate_series(1, $2) g`,
    [FULL, MAX_DASHBOARDS - 1],
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      changeDashboard({ projectId: FULL, action: "create", name: "Board" }, actionDeps(db)),
    ),
  );
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(
    [...new Set(results.flatMap((r) => (r.ok ? [] : [r.error])))],
    [`A project can have ${MAX_DASHBOARDS} dashboards.`],
  );
  assert.equal(await countDashboards(FULL, db), MAX_DASHBOARDS);
});

function actionDeps(db: DashboardsDb): DashboardActionDeps {
  return {
    getSession: async () => ({
      user: { id: "u", externalId: "u", name: "Ada", username: null, email: null },
    }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: projectId },
    }),
    enabled: async () => true,
    features: async () => ({ customMonitoring: false }),
    scorers: async () => [],
    isRestricted: async () => false,
    store: {
      createDashboard: (input) => createDashboard(input, db),
      updateDashboard: (input) => updateDashboard(input, db),
      deleteDashboard: (projectId, id) => deleteDashboard(projectId, id, db),
      changeWidgets: (input) => changeWidgets(input, db),
    },
    observe: async () => {},
  } as DashboardActionDeps;
}

function widget(id: string, x: number) {
  return {
    id,
    title: id,
    query: metricQuery("trace_count", "count"),
    chart: "line" as const,
    layout: { x, y: 0, w: 6, h: 6 },
  };
}

/** The open transactions that wait for a row of this database. */
async function waiting(): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from pg_stat_activity
     where datname = $1 and wait_event_type = 'Lock' and state = 'active'`,
    [DATABASE],
  );
  return rows[0].n;
}

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the two transactions never overlapped");
}

async function asAdmin(statement: string): Promise<void> {
  const client = new Client({ connectionString: server });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
