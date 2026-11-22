import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { WIDGET_LIMIT } from "./model";
import {
  addWidget,
  createDashboard,
  type DashboardEvent,
  type DashboardsDeps,
  readDashboard,
  readDashboards,
  removeDashboard,
  removeWidget,
  renameDashboard,
  reorderWidget,
  shareDashboard,
  updateWidget,
} from "./service";

/** RC-888: dashboard and widget writes, with membership, the edit rule and the widget limit. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const KPI = { metric: "runs", groupBy: null, chart: "kpi", rangeDays: 7, filter: {} };
const BAR = { metric: "cost", groupBy: "pivot:client", chart: "bar", rangeDays: 30, filter: {} };

type Db = ReturnType<typeof getDb>;
type Person = "alice" | "bob" | "mallory";

interface Harness {
  as: (person: Person, options?: { enabled?: boolean; restricted?: boolean }) => DashboardsDeps;
  events: Array<{ event: DashboardEvent; properties: Record<string, unknown> }>;
}

/** alice and bob are members of PROJECT; mallory is a member of OTHER_PROJECT only. */
async function setup(): Promise<Harness> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into project_pivots (project_id, key, label, preset_id, position) values ('${PROJECT}', 'client', 'Client', 'client', 0);
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  const members: Record<Person, string> = { alice: PROJECT, bob: PROJECT, mallory: OTHER_PROJECT };
  const events: Harness["events"] = [];
  return {
    events,
    as: (person, { enabled = true, restricted = false } = {}) => ({
      db,
      getActor: async () => ({ userId: `id_${person}`, externalId: `user_${person}` }),
      findScope: async (projectId) =>
        members[person] === projectId ? { organizationId: ORG } : null,
      isEnabled: async () => enabled,
      isRestricted: async () => restricted,
      track: async (event, _context, properties) => {
        events.push({ event, properties });
      },
    }),
  };
}

async function created(harness: Harness, person: Person = "alice"): Promise<string> {
  const result = await createDashboard(PROJECT, "Costs by client", harness.as(person));
  assert.ok(result.ok);
  return result.dashboard.id;
}

test("a member creates, renames and deletes a dashboard, and the events are sent", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const id = await created(harness);
  assert.deepEqual(await renameDashboard(PROJECT, id, "  Client spend ", alice), { ok: true });
  const read = await readDashboard(PROJECT, id, alice);
  assert.ok(read.ok);
  assert.equal(read.dashboard.name, "Client spend");
  assert.equal(read.dashboard.sharing, "private");
  assert.equal(read.canEdit, true);
  assert.equal((await renameDashboard(PROJECT, id, "", alice)).ok, false);
  assert.deepEqual(await removeDashboard(PROJECT, id, alice), { ok: true });
  assert.equal((await readDashboard(PROJECT, id, alice)).ok, false);
  assert.deepEqual(
    harness.events.map((entry) => entry.event),
    ["dashboard_created", "dashboard_deleted"],
  );
});

test("a member adds, edits, moves and removes widgets of each chart type", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const id = await created(harness);
  const specs = [
    KPI,
    { ...KPI, chart: "line", groupBy: "day" },
    BAR,
    { ...BAR, chart: "table", groupBy: "model" },
  ];
  const widgetIds: string[] = [];
  for (const spec of specs) {
    const added = await addWidget(PROJECT, id, spec, alice);
    assert.ok(added.ok, JSON.stringify(added));
    widgetIds.push(added.widgetId);
  }
  assert.deepEqual(
    await updateWidget(PROJECT, id, widgetIds[0], { ...KPI, metric: "p95" }, alice),
    { ok: true },
  );
  assert.deepEqual(await reorderWidget(PROJECT, id, widgetIds[3], "up", alice), { ok: true });
  assert.deepEqual(await removeWidget(PROJECT, id, widgetIds[1], alice), { ok: true });
  const read = await readDashboard(PROJECT, id, alice);
  assert.ok(read.ok);
  assert.deepEqual(
    read.widgets.map((widget) => [
      widget.id,
      (widget.spec as { metric: string; chart: string }).chart,
    ]),
    [
      [widgetIds[0], "kpi"],
      [widgetIds[3], "table"],
      [widgetIds[2], "bar"],
    ],
  );
  assert.equal((read.widgets[0].spec as { metric: string }).metric, "p95");
  assert.equal(
    harness.events.filter((entry) => entry.event === "dashboard_widget_added").length,
    4,
  );
  assert.deepEqual(
    harness.events.find(
      (entry) => entry.event === "dashboard_widget_added" && entry.properties.chart === "bar",
    )?.properties,
    {
      dashboard_id: id,
      metric: "cost",
      group_by: "pivot",
      chart: "bar",
    },
  );
});

test("a widget outside the whitelist or with an unconfigured pivot is refused", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const id = await created(harness);
  assert.equal(
    ((await addWidget(PROJECT, id, { ...KPI, metric: "revenue" }, alice)) as { code?: string })
      .code,
    "unknown_metric",
  );
  assert.equal(
    (
      (await addWidget(PROJECT, id, { ...BAR, groupBy: "pivot:tenant" }, alice)) as {
        code?: string;
      }
    ).code,
    "unconfigured_pivot",
  );
  assert.equal(
    ((await addWidget(PROJECT, id, { ...KPI, rangeDays: 90 }, alice)) as { code?: string }).code,
    "range_over_retention",
  );
});

test("a dashboard takes at most 20 widgets", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const id = await created(harness);
  for (let i = 0; i < WIDGET_LIMIT; i += 1)
    assert.ok((await addWidget(PROJECT, id, KPI, alice)).ok);
  const refused = await addWidget(PROJECT, id, KPI, alice);
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "limit");
  const read = await readDashboard(PROJECT, id, alice);
  assert.equal(read.ok && read.widgets.length, WIDGET_LIMIT);
});

test("only the creator opens and edits a private dashboard; every member a project one", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const bob = harness.as("bob");
  const id = await created(harness);
  assert.equal(((await readDashboard(PROJECT, id, bob)) as { code?: string }).code, "not_found");
  assert.equal(((await addWidget(PROJECT, id, KPI, bob)) as { code?: string }).code, "not_found");
  assert.equal(
    ((await renameDashboard(PROJECT, id, "Mine now", bob)) as { code?: string }).code,
    "not_found",
  );
  assert.equal(((await removeDashboard(PROJECT, id, bob)) as { code?: string }).code, "not_found");
  assert.deepEqual(
    ((await readDashboards(PROJECT, bob)) as { dashboards: unknown[] }).dashboards,
    [],
  );

  assert.deepEqual(await shareDashboard(PROJECT, id, "project", alice), { ok: true });
  const shared = await readDashboard(PROJECT, id, bob);
  assert.ok(shared.ok);
  assert.equal(shared.canEdit, true);
  assert.ok((await addWidget(PROJECT, id, KPI, bob)).ok);
  assert.deepEqual(await renameDashboard(PROJECT, id, "Team costs", bob), { ok: true });
  assert.equal(shared.canShare, false, "only the creator changes sharing");
  assert.equal(
    ((await shareDashboard(PROJECT, id, "private", bob)) as { code?: string }).code,
    "not_creator",
    "only the creator unshares",
  );
  assert.equal(
    ((await readDashboards(PROJECT, bob)) as { dashboards: unknown[] }).dashboards.length,
    1,
  );
});

test("the creator shares and unshares a dashboard, and each change sends dashboard_shared", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const id = await created(harness);
  const own = await readDashboard(PROJECT, id, alice);
  assert.equal(own.ok && own.canShare, true);
  assert.deepEqual(await shareDashboard(PROJECT, id, "project", alice), { ok: true });
  const shared = await readDashboard(PROJECT, id, harness.as("bob"));
  assert.ok(shared.ok, "a project member opens the shared link");
  assert.equal(shared.dashboard.sharing, "project");
  assert.deepEqual(await shareDashboard(PROJECT, id, "private", alice), { ok: true });
  assert.equal(
    ((await readDashboard(PROJECT, id, harness.as("bob"))) as { code?: string }).code,
    "not_found",
    "unshared, it is gone for bob",
  );
  assert.deepEqual(
    harness.events
      .filter((entry) => entry.event === "dashboard_shared")
      .map((entry) => entry.properties),
    [
      { dashboard_id: id, sharing: "project" },
      { dashboard_id: id, sharing: "private" },
    ],
  );
});

test("a sharing change that is not permitted is refused and sends no event", async () => {
  const harness = await setup();
  const id = await created(harness);
  assert.equal(
    ((await shareDashboard(PROJECT, id, "project", harness.as("bob"))) as { code?: string }).code,
    "not_found",
    "another member's private dashboard",
  );
  assert.equal(
    ((await shareDashboard(PROJECT, id, "project", harness.as("mallory"))) as { code?: string })
      .code,
    "not_found",
    "a user of another project",
  );
  assert.equal(
    ((await shareDashboard(PROJECT, id, "public", harness.as("alice"))) as { code?: string }).code,
    "invalid_sharing",
  );
  assert.equal(
    (
      (await shareDashboard(PROJECT, id, "project", harness.as("alice", { restricted: true }))) as {
        code?: string;
      }
    ).code,
    "restricted",
  );
  assert.equal(
    (
      (await shareDashboard(PROJECT, id, "project", harness.as("alice", { enabled: false }))) as {
        code?: string;
      }
    ).code,
    "not_found",
  );
  assert.equal(harness.events.filter((entry) => entry.event === "dashboard_shared").length, 0);
});

test("a user of another project gets not-found for a private and a project dashboard", async () => {
  const harness = await setup();
  const alice = harness.as("alice");
  const privateId = await created(harness);
  const sharedId = await created(harness);
  await shareDashboard(PROJECT, sharedId, "project", alice);
  for (const id of [privateId, sharedId]) {
    assert.equal(
      ((await readDashboard(PROJECT, id, harness.as("mallory"))) as { code?: string }).code,
      "not_found",
      id,
    );
    assert.equal(
      ((await readDashboard(OTHER_PROJECT, id, harness.as("mallory"))) as { code?: string }).code,
      "not_found",
      id,
    );
  }
});

test("a user outside the project, the flag off and a support session are refused", async () => {
  const harness = await setup();
  const id = await created(harness);
  await shareDashboard(PROJECT, id, "project", harness.as("alice"));
  assert.equal(
    ((await readDashboard(PROJECT, id, harness.as("mallory"))) as { code?: string }).code,
    "not_found",
  );
  assert.equal(
    ((await readDashboard(OTHER_PROJECT, id, harness.as("mallory"))) as { code?: string }).code,
    "not_found",
  );
  assert.equal(
    ((await readDashboards(PROJECT, harness.as("mallory"))) as { code?: string }).code,
    "not_found",
  );
  assert.equal(
    (
      (await readDashboard(PROJECT, id, harness.as("alice", { enabled: false }))) as {
        code?: string;
      }
    ).code,
    "not_found",
  );
  assert.equal(
    (
      (await createDashboard(PROJECT, "x", harness.as("alice", { enabled: false }))) as {
        code?: string;
      }
    ).code,
    "not_found",
  );
  assert.equal(
    (
      (await addWidget(PROJECT, id, KPI, harness.as("alice", { restricted: true }))) as {
        code?: string;
      }
    ).code,
    "restricted",
  );
  assert.ok(
    (await readDashboard(PROJECT, id, harness.as("alice", { restricted: true }))).ok,
    "a support session still reads",
  );
  assert.equal(
    ((await readDashboard(PROJECT, "not-a-uuid", harness.as("alice"))) as { code?: string }).code,
    "not_found",
  );
});
