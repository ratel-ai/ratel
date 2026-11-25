import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { agentToolCount, assembleOperations } from "@/lib/mcp/operations";
import {
  defaultOverviewDeps,
  focusedConsoleForCaller,
  mcpLayoutReader,
  type OverviewOperationDeps,
  overviewOperations,
  overviewWriteOperations,
  WIDGET_DATA,
} from "@/lib/mcp/operations/overview";
import { buildRegistry } from "@/lib/mcp/registry";
import {
  type Db,
  ORGANIZATION_ID,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadFocusedOverview } from "@/lib/views/home/focused-load";
import {
  changeOverviewLayout,
  readOverviewHistory,
  readOverviewLayout,
} from "@/lib/views/overview-layout/actions";
import { createDrizzleOverviewLayoutStore } from "@/lib/views/overview-layout/adapters/drizzle-store";
import { findDashboardWidget } from "@/lib/views/overview-layout/dashboard-widgets";
import {
  type DashboardItemRef,
  DEFAULT_LAYOUT,
  OVERVIEW_WIDGETS,
  type OverviewWidgetId,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";
import { webLayoutReader } from "@/lib/views/overview-layout/readers";
import { overviewLayoutChanges, overviewLayouts } from "@/lib/views/overview-layout/schema";

/** The Overview over MCP, against a database: one person's layout and one set of numbers with the web. */

const NOW = new Date("2026-09-02T12:00:00Z");
const ORGANIZATION = { id: ORGANIZATION_ID, name: "Acme", slug: "acme" };
const PROJECT = { id: PROJECT_ID, name: "Agent", slug: "agent", isDemo: false };
const membership = {
  organizationId: ORGANIZATION_ID,
  role: "member",
  organization: { id: ORGANIZATION_ID, slug: "acme", effectivePlan: "pro" },
};
const person = (externalUserId: string): McpAuthContext => ({
  kind: "oauth",
  externalUserId,
  userId: `row-${externalUserId}`,
  memberships: [membership],
});
const ANA = person("user_ana");
const KEY: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT_ID,
  apiKeyId: "k1",
  scopes: ["*"],
  organization: membership.organization,
};

async function setup(over: Partial<OverviewOperationDeps> = {}) {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(30, () => fresh().search(["create_task"]).invoke("create_task")),
  );
  const store = () => createDrizzleOverviewLayoutStore(db);
  const deps: OverviewOperationDeps = {
    ...defaultOverviewDeps,
    getProject: (async (id: string) =>
      id === PROJECT_ID
        ? { ...PROJECT, organizationId: ORGANIZATION_ID }
        : null) as unknown as OverviewOperationDeps["getProject"],
    getOrganization: async () => ORGANIZATION,
    focusedConsole: async () => true,
    entitiesLinked: async () => true,
    loadOverview: (input) => loadFocusedOverview({ ...input, db }),
    layoutStore: store,
    dashboardsOn: async () => true,
    dashboardWidget: (projectId, ref) => findDashboardWidget(projectId, ref, db as never),
    restricted: async () => false,
    clientName: async () => "claude-code",
    now: () => NOW,
    ...over,
  };
  const registry = buildRegistry([...overviewOperations(deps), ...overviewWriteOperations(deps)]);
  const call = (
    id: string,
    params: Record<string, unknown> = {},
    auth: McpAuthContext = ANA,
    forView = false,
  ) =>
    dispatchOperation(
      id,
      { projectId: PROJECT_ID, ...params },
      {
        registry,
        auth,
        forView,
        projectOwner: async (id) =>
          id === PROJECT_ID ? { organizationId: ORGANIZATION_ID } : null,
      },
    );
  return { db, call, web: webDeps(db, "user_ana"), store };
}

/** A loaded Overview with no widget's data, without a database. */
const empty = ({ layout = DEFAULT_LAYOUT }: Parameters<typeof loadFocusedOverview>[0]) => ({
  project: PROJECT,
  root: "/",
  window: 7 as const,
  rangeParam: "7d" as const,
  lastEventAt: NOW,
  telemetryRead: true,
  hasTelemetry: true,
  layout,
  metrics: null,
  topology: null,
  health: null,
  attention: null,
  dashboards: null,
  context: null,
});

/** The web's own side: the session user of the console scope. */
function webDeps(db: Db, externalId: string) {
  return {
    reader: webLayoutReader({
      scope: async (id) => ({ project: { id }, user: { externalId } }),
      restricted: async () => false,
    }),
    store: () => createDrizzleOverviewLayoutStore(db),
    offered: async () => WIDGET_CATALOG,
    dashboardsOn: async () => true,
    dashboardWidget: (projectId: string, ref: DashboardItemRef) =>
      findDashboardWidget(projectId, ref, db as never),
    source: async () => ({ kind: "web" as const }),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a tool's JSON answer.
function dataOf(result: Awaited<ReturnType<typeof dispatchOperation>>): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

const refusal = (result: Awaited<ReturnType<typeof dispatchOperation>>) =>
  result.ok ? null : [result.error, result.reason];

test("a person's OAuth id and session id are one person, and no other", async () => {
  const web = await webDeps(undefined as never, "user_ana").reader(PROJECT_ID);
  assert.deepEqual(await mcpLayoutReader(ANA, async () => false)(PROJECT_ID), web);
  assert.notDeepEqual(
    await mcpLayoutReader(person("user_ben"), async () => false)(PROJECT_ID),
    web,
  );
});

test("an OAuth session changes the layout, and get_overview and the web read the same one", async () => {
  const { call, web, db } = await setup();
  await call("change_overview_layout", { change: "remove", widget: "topology" });
  const changed = dataOf(
    await call("change_overview_layout", { change: "move", widget: "attention", x: 0, y: 0 }),
  );
  const overview = dataOf(await call("get_overview"));
  assert.deepEqual(overview.layout, { of: "person", ...changed.layout });
  assert.equal(overview.topology, null, "a removed widget has no data");
  assert.equal(overview.layout.widgets[0].id, "attention");

  const read = await readOverviewLayout(PROJECT_ID, web);
  assert.ok(read.ok);
  const page = await loadFocusedOverview({
    project: PROJECT,
    organization: ORGANIZATION,
    window: 7,
    now: NOW,
    layout: read.layout,
    db,
  });
  assert.deepEqual(
    page.layout.map(({ id, removed }) => [id, removed]),
    overview.layout.widgets.map(({ id, removed }: { id: string; removed: boolean }) => [
      id,
      removed,
    ]),
  );

  // And back: a change on the web is what the agent reads.
  await changeOverviewLayout(PROJECT_ID, { kind: "reset" }, web, null);
  const after = dataOf(await call("get_overview"));
  assert.ok(after.layout.widgets.every(({ removed }: { removed: boolean }) => !removed));
  assert.equal(dataOf(await call("get_overview", {}, person("user_ben"))).layout.widgets.length, 4);
});

test("a layout this build cannot read is refused a change, and reset replaces it", async () => {
  const { call, db, store } = await setup();
  const key = { projectId: PROJECT_ID, personId: "user_ana" };
  await db.insert(overviewLayouts).values({ ...key, layout: { version: 2 }, updatedAt: NOW });
  const remove = { change: "remove", widget: "topology" };
  assert.deepEqual(refusal(await call("change_overview_layout", remove)), [
    "forbidden",
    "unreadable",
  ]);
  assert.deepEqual(await store().read(key), { layout: { version: 2 }, entries: [] });
  assert.ok((await call("change_overview_layout", { change: "reset" })).ok);
  assert.ok((await call("change_overview_layout", remove)).ok);
});

test("an agent lists the changes, undoes and restores, and the web shows the result", async () => {
  const { call, web } = await setup();
  const none = dataOf(await call("list_overview_changes"));
  assert.deepEqual([none.changes, none.layout.undoTakesBack], [[], null]);
  await changeOverviewLayout(PROJECT_ID, { kind: "remove", widget: "metrics" }, web, null);
  await call("change_overview_layout", { change: "remove", widget: "topology" });
  const listed = dataOf(await call("list_overview_changes"));
  assert.deepEqual(
    listed.changes.map(
      // biome-ignore lint/suspicious/noExplicitAny: a tool's JSON answer.
      ({ id, what, source, client, author, current }: any) => [
        id,
        what,
        source,
        client,
        author.personId,
        current,
      ],
    ),
    [
      [2, "Removed Agents and MCP servers", "mcp", "claude-code", "user_ana", true],
      [1, "Removed Metrics", "web", undefined, "user_ana", false],
    ],
  );
  assert.equal(listed.layout.undoTakesBack, "Removed Agents and MCP servers");
  assert.ok(listed.changes[0].at && listed.changes[0].layout.widgets.length === 4);
  assert.equal(dataOf(await call("get_overview")).layout.revision, listed.layout.revision);

  const { revision } = listed.layout;
  const undone = dataOf(await call("undo_overview_change", { revision }));
  assert.equal(undone.changed, "Took back: Removed Agents and MCP servers");
  const stale = ["conflict", "stale"];
  assert.deepEqual(refusal(await call("undo_overview_change", { revision })), stale);
  assert.deepEqual(
    refusal(await call("restore_overview_layout", { changeId: 2, revision })),
    stale,
  );
  assert.deepEqual(
    refusal(await call("change_overview_layout", { change: "reset", revision })),
    stale,
  );
  const restored = dataOf(
    await call("restore_overview_layout", { changeId: 2, revision: undone.layout.revision }),
  );
  const onWeb = await readOverviewHistory(PROJECT_ID, web);
  assert.ok(onWeb.ok);
  assert.equal(onWeb.snapshot.revision, restored.layout.revision);
  assert.deepEqual(
    onWeb.entries.map(({ kind, source }) => [kind, source.kind]),
    [
      ["restore", "mcp"],
      ["undo", "mcp"],
      ["change", "mcp"],
      ["change", "web"],
    ],
  );
  assert.deepEqual(
    onWeb.snapshot.layout
      .filter(({ removed }) => removed)
      .map(({ id }) => id)
      .toSorted(),
    ["metrics", "topology"],
  );
  // And a page that was open before them is refused.
  const page = await changeOverviewLayout(PROJECT_ID, { kind: "reset" }, web, revision);
  assert.ok(!page.ok && page.reason === "stale");
  assert.equal(
    refusal(
      await call("restore_overview_layout", { changeId: 99, revision: restored.layout.revision }),
    )?.[0],
    "invalid_params",
  );
});

test("the history, undo and restore are refused to an API key, a support session and a stranger", async () => {
  let restricted = false;
  const { call } = await setup({ restricted: async () => restricted });
  await call("change_overview_layout", { change: "remove", widget: "metrics" });
  const { revision } = dataOf(await call("list_overview_changes")).layout;
  const calls = [
    ["list_overview_changes", {}],
    ["undo_overview_change", { revision }],
    ["restore_overview_layout", { changeId: 1, revision }],
  ] as const;
  const stranger: McpAuthContext = { ...(ANA as { kind: "oauth" }), memberships: [] } as never;
  for (const [id, params] of calls) {
    assert.deepEqual(refusal(await call(id, params, KEY)), ["forbidden", "api_key"], id);
    assert.equal(refusal(await call(id, params, stranger))?.[0], "not_found", id);
    restricted = true;
    assert.deepEqual(refusal(await call(id, params)), ["forbidden", "support_session"], id);
    restricted = false;
  }
  assert.deepEqual(dataOf(await call("list_overview_changes", {}, person("user_ben"))).changes, []);
  assert.equal(dataOf(await call("list_overview_changes")).changes.length, 1);
});

test("the history's own view is drawn from the same entries, and undo draws the Overview", async () => {
  const { call } = await setup();
  await call("change_overview_layout", { change: "remove", widget: "metrics" });
  const listed = await call("list_overview_changes", {}, ANA, true);
  assert.ok(listed.ok);
  // biome-ignore lint/suspicious/noExplicitAny: the view's JSON.
  const view = listed.view as any;
  assert.equal(view.kind, "overview-history");
  assert.deepEqual(
    view.entries.map(({ summary }: { summary: string }) => summary),
    dataOf(listed).changes.map(({ what }: { what: string }) => what),
  );
  assert.deepEqual(
    view.entries.map(({ readable }: { readable: boolean }) => readable),
    [true],
  );
  const { revision } = dataOf(listed).layout;
  const undone = await call("undo_overview_change", { revision }, ANA, true);
  assert.ok(undone.ok && undone.view?.kind === "overview");
});

test("a low-confidence score says so to an agent too", async () => {
  const lowConfidence = { turns: 12, firmsUpAt: 50 };
  const { call } = await setup({
    loadOverview: async (input) => {
      const data = await loadFocusedOverview(input);
      const card = { kind: "score", score: { value: 80 }, early: false, lowConfidence, lost: [] };
      return { ...data, health: { href: "/", windowDays: 7, card } } as never;
    },
  });
  assert.deepEqual(dataOf(await call("get_overview")).health.lowConfidence, lowConfidence);
});

test("the numbers are the web loader's, for both ranges", async () => {
  const { call, db } = await setup();
  for (const [range, window] of [
    ["7d", 7],
    ["30d", 30],
  ] as const) {
    const overview = dataOf(await call("get_overview", { range }));
    const page = await loadFocusedOverview({
      project: PROJECT,
      organization: ORGANIZATION,
      window,
      now: NOW,
      db,
    });
    assert.ok(page.metrics && page.metrics !== "failed");
    assert.ok(page.topology && page.topology !== "failed");
    assert.equal(overview.metrics.runs, page.metrics.traces.count);
    assert.equal(overview.metrics.failedRuns, page.metrics.traces.errorCount);
    assert.equal(overview.metrics.medianDurationMs, page.metrics.traces.p50DurationMs);
    assert.equal(overview.metrics.spendUsd, page.metrics.traces.costUsd);
    assert.deepEqual(overview.metrics.sdk.current, page.metrics.sdk?.current);
    assert.deepEqual(
      overview.attention.rows.map(({ key }: { key: string }) => key),
      page.attention?.items.map(({ key }) => key),
    );
    assert.equal(overview.topology.nodes.length, page.topology.nodes.length);
    assert.deepEqual(overview.topology.leftOut, page.topology.omitted);
    assert.equal(overview.health.href, page.health?.href);
  }
});

test("an API key reads the default layout and cannot change one", async () => {
  const { call, web } = await setup();
  await call("change_overview_layout", { change: "remove", widget: "health" });
  const overview = dataOf(await call("get_overview", {}, KEY));
  assert.equal(overview.layout.of, "default");
  assert.ok(overview.layout.widgets.every(({ removed }: { removed: boolean }) => !removed));
  const refused = await call("change_overview_layout", { change: "reset" }, KEY);
  assert.deepEqual(refusal(refused), ["forbidden", "api_key"]);
  assert.match(refused.ok ? "" : refused.message, /Sign in to the MCP server as a person/);
  const read = await readOverviewLayout(PROJECT_ID, web);
  assert.ok(read.ok && read.layout.some(({ removed }) => removed), "nothing was reset");
});

test("a support session reads the default on both surfaces and cannot change, and the stored layout stays", async () => {
  let restricted = false;
  const { call, store, web } = await setup({ restricted: async () => restricted });
  await call("change_overview_layout", { change: "remove", widget: "topology" });
  const key = { projectId: PROJECT_ID, personId: "user_ana" };
  const personal = await store().read(key);
  assert.ok(personal);

  restricted = true;
  const overview = dataOf(await call("get_overview"));
  assert.equal(overview.layout.of, "default");
  assert.ok(overview.topology, "the default shows the topology");
  const support = {
    ...web,
    reader: webLayoutReader({
      scope: async (id) => ({ project: { id }, user: { externalId: "user_ana" } }),
      restricted: async () => true,
    }),
  };
  assert.deepEqual(await readOverviewLayout(PROJECT_ID, support), {
    ok: true,
    layout: DEFAULT_LAYOUT,
    revision: "0.0",
    undo: null,
  });
  assert.deepEqual(
    refusal(await call("change_overview_layout", { change: "remove", widget: "health" })),
    ["forbidden", "support_session"],
  );
  assert.deepEqual(await changeOverviewLayout(PROJECT_ID, { kind: "reset" }, support, null), {
    ok: false,
    reason: "support_session",
  });
  assert.deepEqual(await store().read(key), personal);

  restricted = false;
  assert.equal(dataOf(await call("get_overview")).layout.of, "person");
  assert.equal(dataOf(await call("get_overview")).topology, null);
});

test("somebody without access to the project gets not_found for both", async () => {
  const { call } = await setup();
  const stranger: McpAuthContext = { ...(ANA as { kind: "oauth" }), memberships: [] } as never;
  for (const [id, params] of [
    ["get_overview", {}],
    ["change_overview_layout", { change: "reset" }],
  ] as const)
    assert.deepEqual(refusal(await call(id, params, stranger))?.[0], "not_found", id);
});

test("a change that misses a parameter says which", async () => {
  const { call } = await setup();
  const result = await call("change_overview_layout", { change: "move", widget: "health" });
  assert.equal(refusal(result)?.[0], "invalid_params");
  assert.match(result.ok ? "" : result.message, /needs these parameters: x, y/);
});

test("the view gets the page's own data, and only a view does", async () => {
  const { call } = await setup();
  const plain = await call("get_overview");
  assert.ok(plain.ok && plain.view === undefined);
  const viewed = await call("get_overview", {}, ANA, true);
  assert.ok(viewed.ok);
  assert.equal(viewed.view?.kind, "overview");
  assert.equal((viewed.view?.overview as { project: { id: string } }).project.id, PROJECT_ID);
});

test("one widget: only its data, with the page's numbers, for both ranges", async () => {
  const { call } = await setup();
  for (const range of ["7d", "30d"]) {
    const page = dataOf(await call("get_overview", { range }));
    for (const widget of OVERVIEW_WIDGETS) {
      const one = dataOf(await call("get_overview", { widget, range }));
      assert.deepEqual(one[widget], page[widget], `${widget} ${range}`);
      assert.ok(one[widget], widget);
      assert.equal(one.widget, widget);
      assert.equal(one.range, range);
      for (const other of OVERVIEW_WIDGETS)
        if (other !== widget) assert.ok(!(other in one), `${other} in ${widget}`);
      assert.ok(!("layout" in one));
    }
  }
});

test("one widget: the loader is asked for it alone, and its view draws it alone", async () => {
  const asked: string[][] = [];
  const { call } = await setup({
    loadOverview: async (input) => {
      asked.push((input.layout ?? []).map(({ id }) => id));
      return empty(input);
    },
  });
  for (const widget of OVERVIEW_WIDGETS) {
    const viewed = await call("get_overview", { widget }, ANA, true);
    assert.ok(viewed.ok);
    assert.equal(viewed.view?.widget, widget);
  }
  assert.deepEqual(
    asked,
    OVERVIEW_WIDGETS.map((id) => [id]),
  );
  const page = await call("get_overview", {}, ANA, true);
  assert.ok(page.ok && page.view && !("widget" in page.view));
});

test("one widget: a removed one can be asked for alone, also with an API key", async () => {
  const { call } = await setup();
  await call("change_overview_layout", { change: "remove", widget: "topology" });
  const whole = await call("get_overview");
  assert.equal(dataOf(whole).topology, null);
  assert.ok(whole.ok);
  assert.match(whole.hint ?? "", /Call get_overview with widget/);
  for (const auth of [ANA, KEY])
    assert.ok(dataOf(await call("get_overview", { widget: "topology" }, auth)).topology.nodes);
});

test("an unknown widget is refused with the names of the widgets", async () => {
  const { call } = await setup();
  const result = await call("get_overview", { widget: "spend" });
  assert.equal(refusal(result)?.[0], "invalid_params");
  assert.match(
    result.ok ? "" : result.message,
    /"spend"\. The widgets are: metrics, topology, health, attention\./,
  );
});

test("a fifth widget has its single-widget read and its place, and no new operation", async () => {
  const alerts = "alerts" as OverviewWidgetId;
  const five = [
    ...WIDGET_CATALOG,
    { id: alerts, min: { w: 3, h: 3 }, place: { x: 0, y: 16, w: 6, h: 4 } },
  ];
  const over: Partial<OverviewOperationDeps> = {
    widgets: five,
    widgetData: { ...WIDGET_DATA, [alerts]: (data: object) => (data as Alerts).alerts },
    loadOverview: async (input) =>
      ({
        ...empty(input),
        alerts: { firing: 2 },
      }) as never,
  };
  type Alerts = { alerts?: { firing: number } };
  const { call } = await setup({ ...over, offeredWidgets: async () => five });
  const one = await call("get_overview", { widget: "alerts" }, ANA, true);
  assert.deepEqual(dataOf(one).alerts, { firing: 2 });
  assert.equal(one.ok && one.view?.widget, "alerts");
  assert.deepEqual(dataOf(await call("get_overview")).alerts, { firing: 2 });
  const listed = overviewOperations({ ...defaultOverviewDeps, ...over });
  assert.deepEqual(
    listed.map(({ id }) => id),
    overviewOperations().map(({ id }) => id),
  );
  assert.match(JSON.stringify(z.toJSONSchema(listed[0].params)), /"attention","alerts"\]/);

  // Behind a flag that is off for this project, it is no widget.
  const off = await setup({ ...over, offeredWidgets: async () => WIDGET_CATALOG });
  assert.equal(
    refusal(await off.call("get_overview", { widget: "alerts" }))?.[0],
    "invalid_params",
  );
});

test("a change of the layout draws the Overview that it made, and only for a view", async () => {
  const { call } = await setup();
  const change = { change: "remove", widget: "topology" };
  const plain = await call("change_overview_layout", change);
  assert.ok(plain.ok && plain.view === undefined);
  const viewed = await call(
    "change_overview_layout",
    { change: "add", widget: "topology" },
    ANA,
    true,
  );
  const page = await call("get_overview", {}, ANA, true);
  assert.ok(viewed.ok && page.ok);
  assert.equal(viewed.view?.kind, "overview");
  assert.deepEqual(viewed.view, page.view);
});

test("a drawing that fails does not make a saved change look refused", async () => {
  const { call } = await setup({
    loadOverview: async () => {
      throw new Error("statement timeout");
    },
  });
  const result = await call(
    "change_overview_layout",
    { change: "remove", widget: "topology" },
    ANA,
    true,
  );
  assert.ok(result.ok && result.view === undefined);
  assert.ok(
    dataOf(result).layout.widgets.some(
      (w: { id: string; removed: boolean }) => w.id === "topology" && w.removed,
    ),
  );
});

test("the flag off is off with the experimental features on", async () => {
  const focused = (organization: { id: string }) =>
    focusedConsoleEnabled(organization, {
      flags: { focusedConsole: false },
      experimentalFeatures: true,
    } as never);
  assert.equal(await focusedConsoleForCaller(ANA, focused), false);
  const { call } = await setup({ focusedConsole: focused });
  for (const widget of [undefined, ...OVERVIEW_WIDGETS])
    assert.deepEqual(refusal(await call("get_overview", widget ? { widget } : {})), [
      "forbidden",
      "focused_console_off",
    ]);
});

test("the flag off: neither operation is listed, and a project whose organization has it off refuses", async () => {
  const ids = (focusedConsole: boolean) =>
    assembleOperations({ focusedConsole }).map(({ id }) => id);
  const calls = [
    ["get_overview", {}],
    ["change_overview_layout", { change: "reset" }],
    ["list_overview_changes", {}],
    ["undo_overview_change", { revision: "0.0" }],
    ["restore_overview_layout", { changeId: 1, revision: "0.0" }],
  ] as const;
  for (const [id] of calls) {
    assert.ok(!ids(false).includes(id));
    assert.ok(ids(true).includes(id));
  }
  assert.ok(ids(false).includes("get_project_overview"), "it stays");
  assert.equal(agentToolCount({ focusedConsole: true }), agentToolCount() + calls.length);

  const { call, db } = await setup({ focusedConsole: async () => false });
  for (const [id, params] of calls)
    assert.deepEqual(refusal(await call(id, params)), ["forbidden", "focused_console_off"], id);
  assert.deepEqual(await db.select().from(overviewLayoutChanges), [], "no row");
});

test("a connection lists the tools when one of its organizations has the flag", async () => {
  const on = async ({ id }: { id: string }) => id === ORGANIZATION_ID;
  assert.equal(await focusedConsoleForCaller(KEY, on), true);
  assert.equal(await focusedConsoleForCaller(ANA, on), true);
  assert.equal(await focusedConsoleForCaller({ ...KEY, organization: null }, on), false);
  assert.equal(await focusedConsoleForCaller(ANA, async () => false), false);
});
