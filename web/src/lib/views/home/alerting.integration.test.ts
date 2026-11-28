import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertsWidget } from "@/components/console/home/focused/AlertsWidget";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { metricQuery } from "@/lib/contracts/query";
import { WIDGET_DATA } from "@/lib/mcp/operations/overview";
import type { getDb } from "@/lib/platform/db/client";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listAlertingRules } from "@/lib/views/alerts/store";
import { FOCUSED_READS, loadFocusedOverview } from "@/lib/views/home/focused-load";
import {
  changeLayout,
  defaultLayout,
  type OverviewLayout,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-24T10:00:00Z");

const INPUT = {
  project: { id: PROJECT, name: "Agent", slug: "agent", isDemo: false },
  organization: { id: ORG } as Parameters<typeof loadFocusedOverview>[0]["organization"],
  window: 7 as const,
  now: NOW,
};

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: BoundReadDb;
/** Every statement of the load that runs now. */
let queries: string[] = [];

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, {
    schema,
    logger: { logQuery: (query) => void queries.push(query) },
  }) as unknown as BoundReadDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
});
beforeEach(() => client.exec("delete from alert_rules"));
after(() => client.close());

test("one alerting rule is one row, with its value, condition, age and link", async () => {
  const id = await rule({ minutesAgo: 12 });
  const { alerts } = await load();
  assert.deepEqual(alerts, {
    items: [
      {
        id,
        name: "Too many errors",
        value: "66.7%",
        condition: "above 50%",
        since: "12m ago",
        href: `/project/${PROJECT}/alerts/${id}`,
      },
    ],
    href: `/project/${PROJECT}/alerts`,
    newHref: `/project/${PROJECT}/alerts/new`,
    rules: null,
  });
  const text = drawn(alerts)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
  assert.match(text, /Too many errors 66\.7% above 50% · 12m ago/);
  assert.match(drawn(alerts), new RegExp(`href="/project/${PROJECT}/alerts/${id}"`));
});

test("a recovered rule gives none; nor does one in no data, paused, malformed or of another project", async () => {
  const id = await rule({});
  await client.query("update alert_rules set state = 'ok' where id = $1", [id]);
  await rule({ state: "no_data" });
  await rule({ enabled: false });
  await rule({ query: { bad: true } });
  await rule({ projectId: OTHER });
  const { alerts } = await load();
  assert.deepEqual(alerts, {
    items: [],
    href: `/project/${PROJECT}/alerts`,
    newHref: `/project/${PROJECT}/alerts/new`,
    // Another project's rule is not counted.
    rules: { total: 4, on: 3, noData: 1 },
  });
  assert.match(drawn(alerts), /No alert fires now/);
});

test("every alerting rule, the newest change first", async () => {
  for (let minutesAgo = 7; minutesAgo > 0; minutesAgo--)
    await rule({ name: `r${minutesAgo}`, minutesAgo });
  const { alerts } = await load();
  assert.ok(alerts && alerts !== "failed");
  assert.deepEqual(
    alerts.items.map(({ name }) => name),
    ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
  );
  assert.equal((await listAlertingRules(PROJECT, db, 2)).length, 2);
});

test("a removed widget reads nothing", async () => {
  await rule({});
  const removed = changeLayout(defaultLayout(WIDGET_CATALOG), { kind: "remove", widget: "alerts" });
  const off = await load(removed);
  assert.equal(off.alerts, null);
  assert.equal(off.reads, 0);
  assert.equal((await load()).reads, 1);
});

test("a read that fails says so, on the page and to an agent", async () => {
  const data = await loadFocusedOverview({
    ...INPUT,
    layout: defaultLayout(WIDGET_CATALOG),
    db: db as ReturnType<typeof getDb>,
    reads: { ...FOCUSED_READS, alerting: () => Promise.reject(new Error("statement timeout")) },
  });
  assert.equal(data.alerts, "failed");
  const { alerts } = widgetBodies(data, false);
  assert.match(renderToStaticMarkup(createElement("div", null, alerts)), /The alerts did not load/);
  assert.deepEqual(WIDGET_DATA.alerts(data), { failed: true });
});

test("an agent reads the rows that the page shows", async () => {
  await rule({});
  const data = await load();
  assert.ok(data.alerts && data.alerts !== "failed");
  assert.deepEqual(WIDGET_DATA.alerts(data), {
    count: 1,
    rows: data.alerts.items,
    href: data.alerts.href,
    rules: null,
  });
});

async function load(layout: OverviewLayout = defaultLayout(WIDGET_CATALOG)) {
  queries = [];
  const data = await loadFocusedOverview({
    ...INPUT,
    layout,
    db: db as ReturnType<typeof getDb>,
  });
  return { ...data, reads: queries.filter((query) => query.includes("alert_rules")).length };
}

function drawn(alerts: Awaited<ReturnType<typeof load>>["alerts"]): string {
  assert.ok(alerts && alerts !== "failed");
  return renderToStaticMarkup(createElement(AlertsWidget, { alerts }));
}

async function rule(over: {
  name?: string;
  state?: string;
  enabled?: boolean;
  projectId?: string;
  query?: unknown;
  minutesAgo?: number;
}): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into alert_rules (project_id, name, query, operator, threshold, window_minutes,
       enabled, state, last_value, state_changed_at, created_by, updated_by)
     values ($1, $2, $3, 'above', 0.5, 5, $4, $5, 0.6667, $6, 'u', 'u') returning id`,
    [
      over.projectId ?? PROJECT,
      over.name ?? "Too many errors",
      JSON.stringify(over.query ?? metricQuery("error_rate", "rate")),
      over.enabled ?? true,
      over.state ?? "alerting",
      new Date(NOW.getTime() - (over.minutesAgo ?? 1) * 60_000),
    ],
  );
  return rows[0]!.id;
}
