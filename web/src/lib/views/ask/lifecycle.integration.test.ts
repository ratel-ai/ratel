import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
import * as store from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import { draftedDashboard } from "./build";
import { draftWidgets } from "./draft";
import { ASK_MODEL } from "./limits";
import { askRequests } from "./schema";
import { askLeftOut, type DashboardChange, followDashboardChange, linkAsk } from "./store";

/**
 * Decision `ask-no-confirm`: an ask that built a dashboard is kept at the build, edited when one of
 * its widgets is later changed or removed, and discarded when the dashboard is deleted, through
 * the dashboard actions that the console and MCP share.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-24T12:00:00Z");

const GOOD = [
  {
    title: "Traces per hour",
    rql: "select time_bucket('1 hour', started_at) as hour, count(*) as n from traces group by hour",
    chart: "line",
  },
  { title: "Error rate", rql: "select rate(has_error) as error_rate from traces", chart: "number" },
];
const BROKEN = { title: "Broken", rql: "select nothing from nowhere", chart: "bar" };

let db: ReturnType<typeof getDb>;
let changes: DashboardChange[];

beforeEach(async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  changes = [];
});

function deps(): DashboardActionDeps {
  return {
    getSession: async () => ({
      user: { id: "u1", externalId: "u1", name: "Ann", username: null, email: "ann@example.com" },
    }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
    scorers: async () => [],
    isRestricted: async () => false,
    templates: { indexedProperties: async () => [], recordPick: async () => {} },
    store: {
      createDashboard: (input) => store.createDashboard(input, db),
      updateDashboard: (input) => store.updateDashboard(input, db),
      deleteDashboard: (projectId, id) => store.deleteDashboard(projectId, id, db),
      changeWidgets: (input) => store.changeWidgets(input, db),
    },
    observe: async () => {},
    afterChange: async (change) => {
      changes.push(change);
      await followDashboardChange(change, NOW, db);
    },
  };
}

/** A build as the console's action does it: a draft, one import, then the link. */
async function build(
  range?: unknown,
): Promise<{ askId: string; dashboardId: string; widgetIds: string[] }> {
  const draft = await draftWidgets(
    {
      projectId: PROJECT,
      actor: "u1",
      surface: "console",
      target: "dashboard",
      dashboardId: null,
      words: "How busy and how broken?",
    },
    {
      model: {
        model: ASK_MODEL,
        standIn: false,
        complete: async () => ({
          text: JSON.stringify({ widgets: [...GOOD, BROKEN], range }),
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
      db: db as never,
      now: () => NOW,
    },
  );
  assert.equal(draft.status, "drafted");
  if (draft.status !== "drafted") throw new Error("no draft");
  const made = await changeDashboard(
    {
      projectId: PROJECT,
      action: "import",
      document: draftedDashboard("Agent", draft.widgets, draft.range),
    },
    deps(),
  );
  if (!made.ok) throw new Error("the dashboard was not made");
  const dashboard = await store.getDashboard(PROJECT, made.dashboardId, db);
  const widgetIds = (dashboard?.widgets ?? []).filter(isWidget).map(({ id }) => id);
  await linkAsk(PROJECT, draft.askId, { dashboardId: made.dashboardId, widgetIds }, NOW, db);
  return { askId: draft.askId, dashboardId: made.dashboardId, widgetIds };
}

async function outcomeOf(askId: string) {
  const [row] = await db.select().from(askRequests).where(eq(askRequests.id, askId));
  return row?.outcome;
}

test("a build is kept, makes only the good widgets, and names the one left out", async () => {
  const { askId, dashboardId, widgetIds } = await build();
  assert.equal(await outcomeOf(askId), "kept");
  assert.equal(widgetIds.length, 2);
  const [row] = await db.select().from(askRequests).where(eq(askRequests.id, askId));
  assert.equal(row?.dashboardId, dashboardId);
  assert.deepEqual(row?.widgetIds, widgetIds);
  const leftOut = await askLeftOut(PROJECT, askId, db);
  assert.deepEqual(
    leftOut?.map(({ title }) => title),
    ["Broken"],
  );
});

test("a change of another widget keeps the outcome; a change of a drafted one makes it edited", async () => {
  const { askId, dashboardId, widgetIds } = await build();
  const added = await changeDashboard(
    {
      projectId: PROJECT,
      action: "add-widget",
      dashboardId,
      widget: {
        title: "Mine",
        query: { version: 1, kind: "sql", text: "select count(*) as n from traces", rqlVersion: 1 },
        chart: "number",
      },
    },
    deps(),
  );
  assert.ok(added.ok);
  const addedId = changes.at(-1)?.widgetId;
  assert.ok(addedId && !widgetIds.includes(addedId), "the add reports the new widget");
  await changeDashboard(
    { projectId: PROJECT, action: "remove-widget", dashboardId, widgetId: addedId },
    deps(),
  );
  await changeDashboard({ projectId: PROJECT, action: "rename", dashboardId, name: "New" }, deps());
  assert.equal(await outcomeOf(askId), "kept");

  await changeDashboard(
    {
      projectId: PROJECT,
      action: "edit-widget",
      dashboardId,
      widgetId: widgetIds[0],
      widget: {
        title: "Runs per hour",
        query: { version: 1, kind: "sql", text: GOOD[0]?.rql ?? "", rqlVersion: 1 },
        chart: "line",
      },
    },
    deps(),
  );
  assert.equal(await outcomeOf(askId), "edited");
});

test("a removal of a drafted widget makes it edited, and a delete of the dashboard discarded", async () => {
  const { askId, dashboardId, widgetIds } = await build();
  await changeDashboard(
    { projectId: PROJECT, action: "remove-widget", dashboardId, widgetId: widgetIds[1] },
    deps(),
  );
  assert.equal(await outcomeOf(askId), "edited");
  await changeDashboard({ projectId: PROJECT, action: "delete", dashboardId }, deps());
  assert.equal(await outcomeOf(askId), "discarded");
});

test("a build from words that name a range of the page opens on it; another range leaves the default", async () => {
  const named = await build("14d");
  assert.equal((await store.getDashboard(PROJECT, named.dashboardId, db))?.range, "14d");
  for (const outside of ["2d", ""]) {
    const other = await build(outside);
    assert.equal((await store.getDashboard(PROJECT, other.dashboardId, db))?.range, null);
  }
});
