import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { listPivots } from "@/lib/ingest/pivots/store";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import {
  type DashboardsOperationDeps,
  dashboardsOperations,
} from "@/lib/mcp/operations/dashboards";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { runWidgetQuery } from "@/lib/views/custom-dashboards/query";
import {
  findDashboard,
  insertDashboard,
  insertWidget,
  listOpenDashboards,
  listWidgets,
  updateDashboardSharing,
} from "@/lib/views/custom-dashboards/store";
import { loadWidgetData } from "@/lib/views/custom-dashboards/widget-data";

/**
 * Custom dashboards over MCP (RC-889): `list_dashboards` and `get_dashboard`
 * read the project's dashboards and each widget's rows. A project API key has
 * no person, so it reads only the dashboards shared with the project.
 */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;

type Db = ReturnType<typeof getDb>;

const keyAuth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: ORG, slug: "org", effectivePlan: "pro" },
};

const KPI = { metric: "runs", groupBy: null, chart: "kpi", rangeDays: 7, filter: {} };
const BAR = { metric: "cost", groupBy: "model", chart: "bar", rangeDays: 7, filter: {}, topN: 1 };

interface Seeded {
  db: Db;
  shared: string;
  privateId: string;
  widgets: string[];
}

/** Two dashboards of alice: "Team costs" shared with two widgets, "Mine" private. Three traces in the window. */
async function seed(): Promise<Seeded> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
  `);
  for (const [trace, models, cost] of [
    ["t1", ["gpt"], 0.1],
    ["t2", ["gpt"], 0.2],
    ["t3", ["claude"], 0.4],
  ] as const) {
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, models, tools, dims, spans_max_received_at)
       values ($1, $2, $3, 100, false, 0, 0, $4, $5, '{}', '{}'::jsonb, $3)`,
      [PROJECT, trace, new Date(NOW.getTime() - HOUR).toISOString(), cost, models],
    );
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  const shared = (await insertDashboard(PROJECT, "Team costs", "user_alice", db)).id;
  await updateDashboardSharing(PROJECT, shared, "project", db);
  const privateId = (await insertDashboard(PROJECT, "Mine", "user_alice", db)).id;
  const widgets: string[] = [];
  for (const spec of [KPI, BAR]) {
    const inserted = await insertWidget(PROJECT, shared, spec, db);
    assert.equal(inserted.outcome, "inserted");
    if (inserted.outcome === "inserted") widgets.push(inserted.id);
  }
  return { db, shared, privateId, widgets };
}

function harness(seeded: Seeded, options: { auth?: McpAuthContext } = {}) {
  const { db } = seeded;
  const deps: DashboardsOperationDeps = {
    listDashboards: (projectId, viewer) => listOpenDashboards(projectId, viewer, db),
    findDashboard: (projectId, dashboardId) => findDashboard(projectId, dashboardId, db),
    listWidgets: (dashboardId) => listWidgets(dashboardId, db),
    listPivots: (projectId) => listPivots(projectId, db),
    loadWidgetData: (projectId, widgets, pivots) =>
      loadWidgetData(projectId, widgets, {
        pivots,
        run: (id, spec, configured) =>
          runWidgetQuery(id, spec, { db, now: NOW, pivots: configured }),
      }),
  };
  const auth = options.auth ?? keyAuth;
  const run = (operationId: string, params: unknown) =>
    dispatchOperation(operationId, params, {
      registry: buildRegistry(dashboardsOperations(deps)),
      auth,
      ...(auth.kind === "oauth" ? { projectOwner: async () => ({ organizationId: ORG }) } : {}),
    });
  return { run };
}

function data<T>(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as T;
}

test("get_dashboard returns the dashboard, its widgets, their specs and their rows", async () => {
  const seeded = await seed();
  const { run } = harness(seeded);
  const out = data<{
    id: string;
    name: string;
    sharing: string;
    href: string;
    widgets: Array<Record<string, unknown>>;
  }>(await run("get_dashboard", { dashboardId: seeded.shared }));
  assert.equal(out.id, seeded.shared);
  assert.equal(out.name, "Team costs");
  assert.equal(out.sharing, "project");
  assert.equal(out.href, `/project/${PROJECT}/dashboards/${seeded.shared}`);
  assert.deepEqual(out.widgets, [
    {
      id: seeded.widgets[0],
      title: "Runs",
      spec: KPI,
      result: { kind: "total", value: 3, runs: 3 },
    },
    {
      id: seeded.widgets[1],
      title: "Cost by model",
      spec: BAR,
      result: {
        kind: "groups",
        groupBy: "model",
        groups: [{ key: "gpt", value: 0.3, runs: 2 }],
        other: { value: 0.4, runs: 1 },
      },
    },
  ]);
});

test("a project API key never reads a private dashboard, in the list or by id", async () => {
  const seeded = await seed();
  const { run } = harness(seeded);
  const listed = data<{ dashboards: Array<{ id: string; sharing: string }> }>(
    await run("list_dashboards", {}),
  );
  assert.deepEqual(
    listed.dashboards.map((dashboard) => [dashboard.id, dashboard.sharing]),
    [[seeded.shared, "project"]],
  );
  const result = await run("get_dashboard", { dashboardId: seeded.privateId });
  assert.equal(result.ok === false && result.error, "not_found");
});

test("a person over OAuth reads their own private dashboard too", async () => {
  const seeded = await seed();
  const auth: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_alice",
    userId: "id_alice",
    memberships: [
      {
        organizationId: ORG,
        role: "admin",
        organization: { id: ORG, slug: "org", effectivePlan: "pro" },
      },
    ],
  };
  const { run } = harness(seeded, { auth });
  const listed = data<{ dashboards: Array<{ id: string }> }>(
    await run("list_dashboards", { projectId: PROJECT }),
  );
  assert.deepEqual(
    new Set(listed.dashboards.map((dashboard) => dashboard.id)),
    new Set([seeded.shared, seeded.privateId]),
  );
  assert.equal(
    data<{ name: string }>(
      await run("get_dashboard", { projectId: PROJECT, dashboardId: seeded.privateId }),
    ).name,
    "Mine",
  );
});
