import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { metricQuery } from "@/lib/contracts/query";
import { runMigrations } from "@/lib/platform/db/migrate";
import * as schema from "@/lib/platform/db/tables";
import { type AlertActionDeps, changeAlert } from "@/lib/views/alerts/actions";
import * as store from "@/lib/views/alerts/store";
import { type AlertDraft, MAX_ALERT_RULES } from "@/lib/views/alerts/types";

/**
 * Transactions that overlap need connections of their own, which PGlite does not have. With
 * TEST_POSTGRES_URL (a server where a database may be created) this runs on a database of its own.
 */
const server = process.env.TEST_POSTGRES_URL;
const DATABASE = `ratel_alerts_${process.pid}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const DRAFT: AlertDraft = {
  name: "Too many errors",
  query: metricQuery("error_rate", "rate"),
  operator: "above",
  threshold: 0.5,
  windowMinutes: 5,
  destinationIds: [],
};

let pool: Pool;

before(async () => {
  if (!server) return;
  await asAdmin(`create database ${DATABASE}`);
  const url = new URL(server);
  url.pathname = `/${DATABASE}`;
  await runMigrations({ url: url.href, sslMode: "disable" });
  pool = new Pool({ connectionString: url.href, max: 12 });
  await pool.query(
    `insert into projects (id, organization_id, name, slug) values ($1, $1, 'Agent', 'agent')`,
    [PROJECT],
  );
});

after(async () => {
  if (!server) return;
  await pool.end();
  await asAdmin(`drop database ${DATABASE}`);
});

test("F446-4: creates at the same time never pass the limit of rules", {
  skip: !server,
}, async () => {
  const db = drizzle(pool, { schema }) as unknown as store.AlertsDb;
  await pool.query(
    `insert into alert_rules (project_id, name, query, operator, threshold, window_minutes, created_by, updated_by)
     select $1, 'r' || g, '{}'::jsonb, 'above', 1, 5, 'u', 'u' from generate_series(1, $2) g`,
    [PROJECT, MAX_ALERT_RULES - 1],
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      changeAlert({ projectId: PROJECT, action: "create", draft: DRAFT }, deps(db)),
    ),
  );
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(
    [...new Set(results.flatMap((r) => (r.ok ? [] : [r.error])))],
    [`A project can have ${MAX_ALERT_RULES} alerts.`],
  );
  assert.equal(await store.countAlertRules(PROJECT, db), MAX_ALERT_RULES);
});

function deps(db: store.AlertsDb): AlertActionDeps {
  return {
    getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
    findProjectScope: async (id) => ({ project: { id }, organization: { id: PROJECT } }),
    enabled: async () => true,
    isRestricted: async () => false,
    features: async () => ({ customMonitoring: false }),
    store: {
      createAlertRule: (p, d, a) => store.createAlertRule(p, d, a, db),
      updateAlertRule: (p, i, d, a) => store.updateAlertRule(p, i, d, a, db),
      setAlertRuleEnabled: (p, i, e, a) => store.setAlertRuleEnabled(p, i, e, a, db),
      deleteAlertRule: (p, i) => store.deleteAlertRule(p, i, db),
    } as AlertActionDeps["store"],
    observe: async () => {},
  };
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
