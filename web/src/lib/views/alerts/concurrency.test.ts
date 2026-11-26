import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { metricQuery } from "@/lib/contracts/query";
import { runMigrations } from "@/lib/platform/db/migrate";
import * as schema from "@/lib/platform/db/tables";
import { type AlertActionDeps, changeAlert } from "@/lib/views/alerts/actions";
import {
  changeDestination,
  type DestinationActionDeps,
} from "@/lib/views/alerts/destination-actions";
import {
  countDestinations,
  createChannelDestination,
  createDestination,
  MAX_DESTINATIONS,
} from "@/lib/views/alerts/destinations";
import * as store from "@/lib/views/alerts/store";
import { type AlertDraft, MAX_ALERT_RULES } from "@/lib/views/alerts/types";

/**
 * Transactions that overlap need connections of their own, which PGlite does not have. With
 * TEST_POSTGRES_URL (a server where a database may be created) this runs on a database of its own.
 */
const server = process.env.TEST_POSTGRES_URL;
const DATABASE = `ratel_alerts_${process.pid}`;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const CHANNELS = "55555555-5555-4555-8555-555555555555";
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
    `insert into projects (id, organization_id, name, slug) values ($1, $1, 'Agent', 'agent'), ($2, $2, 'Channels', 'channels')`,
    [PROJECT, CHANNELS],
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

test("creates of destinations at the same time never pass their limit", {
  skip: !server,
}, async () => {
  const db = drizzle(pool, { schema }) as unknown as store.AlertsDb;
  await pool.query(
    `insert into alert_destinations (id, project_id, name, kind, team_id, channel_id, created_by)
     select gen_random_uuid(), $1, 'c' || g, 'slack_channel', 'T1', 'C' || g, 'u' from generate_series(1, $2) g`,
    [CHANNELS, MAX_DESTINATIONS - 2],
  );
  const webhooks = Array.from({ length: 5 }, (_, i) =>
    changeDestination(
      {
        projectId: CHANNELS,
        action: "add",
        name: `Hook ${i}`,
        url: `https://hooks.slack.com/services/T/B/x${i}`,
      },
      destinationDeps(db),
    ),
  );
  const channels = Array.from({ length: 5 }, (_, i) =>
    changeDestination(
      { projectId: CHANNELS, action: "add_channel", channelId: `CNEW0000${i}` },
      destinationDeps(db),
    ),
  );
  const results = await Promise.all([...webhooks, ...channels]);
  assert.equal(results.filter(({ ok }) => ok).length, 2);
  assert.deepEqual(
    [...new Set(results.flatMap((r) => (r.ok ? [] : [r.error])))],
    [`A project can have ${MAX_DESTINATIONS} destinations.`],
  );
  assert.equal(await countDestinations(CHANNELS, db), MAX_DESTINATIONS);
});

function destinationDeps(db: store.AlertsDb): DestinationActionDeps {
  return {
    getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
    findProjectScope: async (id: string) => ({ project: { id }, organization: { id } }),
    enabled: async () => true,
    isRestricted: async () => false,
    canSeal: () => true,
    create: (input: Parameters<typeof createDestination>[0]) =>
      createDestination({ ...input, key: "test-key" }, db),
    channelAccess: async (_organization: string, channelId: string) => ({
      ok: true,
      teamId: "T1",
      name: channelId.toLowerCase(),
    }),
    createChannel: (input: Parameters<typeof createChannelDestination>[0]) =>
      createChannelDestination(input, db),
    remove: async () => false,
    sealed: async () => null,
    post: async () => ({ ok: true }),
    projectName: async () => "Channels",
    observe: async () => {},
  } as unknown as DestinationActionDeps;
}

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
