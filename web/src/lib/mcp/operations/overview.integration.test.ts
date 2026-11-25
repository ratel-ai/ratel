import assert from "node:assert/strict";
import { test } from "node:test";
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
import { changeOverviewLayout, readOverviewLayout } from "@/lib/views/overview-layout/actions";
import { createDrizzleOverviewLayoutStore } from "@/lib/views/overview-layout/adapters/drizzle-store";
import { DEFAULT_LAYOUT, WIDGET_CATALOG } from "@/lib/views/overview-layout/domain/layout";
import { webLayoutReader } from "@/lib/views/overview-layout/readers";

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
    restricted: async () => false,
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

/** The web's own side: the session user of the console scope. */
function webDeps(db: Db, externalId: string) {
  return {
    reader: webLayoutReader({
      scope: async (id) => ({ project: { id }, user: { externalId } }),
      restricted: async () => false,
    }),
    store: () => createDrizzleOverviewLayoutStore(db),
    offered: async () => WIDGET_CATALOG,
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
  await changeOverviewLayout(PROJECT_ID, { kind: "reset" }, web);
  const after = dataOf(await call("get_overview"));
  assert.ok(after.layout.widgets.every(({ removed }: { removed: boolean }) => !removed));
  assert.equal(dataOf(await call("get_overview", {}, person("user_ben"))).layout.widgets.length, 4);
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
  });
  assert.deepEqual(
    refusal(await call("change_overview_layout", { change: "remove", widget: "health" })),
    ["forbidden", "support_session"],
  );
  assert.deepEqual(await changeOverviewLayout(PROJECT_ID, { kind: "reset" }, support), {
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

test("the flag off: neither operation is listed, and a project whose organization has it off refuses", async () => {
  const ids = (focusedConsole: boolean) =>
    assembleOperations({ focusedConsole }).map(({ id }) => id);
  for (const id of ["get_overview", "change_overview_layout"]) {
    assert.ok(!ids(false).includes(id));
    assert.ok(ids(true).includes(id));
  }
  assert.ok(ids(false).includes("get_project_overview"), "it stays");
  assert.equal(agentToolCount({ focusedConsole: true }), agentToolCount() + 2);

  const { call } = await setup({ focusedConsole: async () => false });
  for (const [id, params] of [
    ["get_overview", {}],
    ["change_overview_layout", { change: "reset" }],
  ] as const)
    assert.deepEqual(refusal(await call(id, params)), ["forbidden", "focused_console_off"], id);
});

test("a connection lists the tools when one of its organizations has the flag", async () => {
  const on = async ({ id }: { id: string }) => id === ORGANIZATION_ID;
  assert.equal(await focusedConsoleForCaller(KEY, on), true);
  assert.equal(await focusedConsoleForCaller(ANA, on), true);
  assert.equal(await focusedConsoleForCaller({ ...KEY, organization: null }, on), false);
  assert.equal(await focusedConsoleForCaller(ANA, async () => false), false);
});
