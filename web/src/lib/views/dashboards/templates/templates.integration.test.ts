import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { MetricsDb } from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { buildCandidates } from "@/lib/views/ask/suggest";
import { loadSuggestInput } from "@/lib/views/ask/suggest-pick";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { textToRun } from "@/lib/views/dashboards/metric-rql";
import type { DashboardsDb } from "@/lib/views/dashboards/store";
import * as store from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import { DASHBOARD_TEMPLATES, templateDashboard } from "@/lib/views/dashboards/templates";
import { COST_TEMPLATE } from "@/lib/views/dashboards/templates/cost";
import { loadTemplateFacts, templateData } from "@/lib/views/dashboards/templates/data";
import {
  ensureDefaultDashboards,
  listTemplatePicks,
  templateActionDeps,
} from "@/lib/views/dashboards/templates/store";
import { isMetricChart } from "@/lib/views/dashboards/widget";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const DEFAULTS = ["Tools", "Cost", "Reliability"];

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: DashboardsDb & MetricsDb;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as DashboardsDb & MetricsDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
});
beforeEach(() =>
  client.exec(`
    delete from dashboard_template_uses; delete from dashboards; delete from trace_property_keys;
    delete from otel_spans; delete from otel_trace_summaries;`),
);
after(() => client.close());

function deps(over: Partial<DashboardActionDeps> = {}): DashboardActionDeps {
  return {
    getSession: async () => ({
      user: { id: "u1", externalId: "ext-1", name: "Ada", username: null, email: "a@x.dev" },
    }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    scorers: async () => [],
    isRestricted: async () => false,
    templates: templateActionDeps(db),
    store: {
      createDashboard: (input) => store.createDashboard(input, db),
      updateDashboard: (input) => store.updateDashboard(input, db),
      deleteDashboard: (projectId, id) => store.deleteDashboard(projectId, id, db),
      changeWidgets: (input) => store.changeWidgets(input, db),
    },
    observe: async () => {},
    ...over,
  };
}

async function change(input: object, projectId = PROJECT) {
  return changeDashboard({ projectId, ...input }, deps());
}

async function names(projectId = PROJECT) {
  return (await store.listDashboards(projectId, db)).map(({ name }) => name);
}

async function seed(projectId: string) {
  const now = new Date();
  await client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, end_user_id, session_id)
     values ($1, 't1', $2, 100, true, 10, 5, 0.25, $2, $2, 'end-user', 'session-1')`,
    [projectId, now],
  );
  await client.query(
    `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at,
       ended_at, duration_ms, status_code, model, input_tokens, output_tokens, cost_usd, attributes, agent_key)
     values
       (gen_random_uuid(), $1, 't1', 's1', 'chat', 1, 'llm_call', $2, $2, 40, 2, 'model-a', 10, 5, 0.25, '{}', 'planner'),
       (gen_random_uuid(), $1, 't1', 's2', 'search_docs', 1, 'tool', $2, $2, 20, 2, null, null, null, null, '{}', 'planner')`,
    [projectId, now],
  );
}

test("a new project gets Tools, Cost and Reliability one time, signed by Ratel", async () => {
  const made = await ensureDefaultDashboards(PROJECT, db);
  assert.equal(made.length, 3);
  const listed = await store.listDashboards(PROJECT, db);
  assert.deepEqual(
    listed.map(({ name }) => name),
    DEFAULTS,
  );
  assert.ok(listed.every(({ updatedByName }) => updatedByName === "Ratel"));
  assert.ok(listed.every(({ widgetCount }) => widgetCount >= 5));
  // A second read adds nothing.
  assert.deepEqual(await ensureDefaultDashboards(PROJECT, db), []);
  assert.deepEqual(await names(), DEFAULTS);
  // Another project is not touched.
  assert.deepEqual(await names(OTHER), []);
});

test("a project that existed before keeps its dashboards and gets the defaults too", async () => {
  assert.ok((await change({ action: "create", name: "Mine" })).ok);
  await ensureDefaultDashboards(PROJECT, db);
  assert.deepEqual(await names(), ["Mine", ...DEFAULTS]);
});

test("a deleted default does not come back", async () => {
  await ensureDefaultDashboards(PROJECT, db);
  const [tools] = await store.listDashboards(PROJECT, db);
  assert.ok((await change({ action: "delete", dashboardId: tools.id })).ok);
  assert.deepEqual(await ensureDefaultDashboards(PROJECT, db), []);
  assert.deepEqual(await names(), ["Cost", "Reliability"]);
});

test("two reads at the same time make each default once", async () => {
  const both = await Promise.all([
    ensureDefaultDashboards(PROJECT, db),
    ensureDefaultDashboards(PROJECT, db),
    ensureDefaultDashboards(PROJECT, db),
  ]);
  assert.equal(both.flat().length, 3);
  assert.deepEqual(await names(), DEFAULTS);
  // The unique key holds even when a second writer gets past the lock.
  await assert.rejects(
    client.query(
      `insert into dashboard_template_uses (project_id, template_id, given, actor)
       values ($1, 'tools', 'default', 'system')`,
      [PROJECT],
    ),
    /dashboard_template_uses_default_key/,
  );
});

test("a default is a normal dashboard: renamed, edited and deleted, and a template change leaves it", async () => {
  await ensureDefaultDashboards(PROJECT, db);
  const [, cost] = await store.listDashboards(PROJECT, db);
  const before = await store.getDashboard(PROJECT, cost.id, db);
  assert.ok(before);

  // A later change of the template in code changes no stored dashboard.
  const original = { name: COST_TEMPLATE.name, widgets: COST_TEMPLATE.widgets };
  Object.assign(COST_TEMPLATE, { name: "Spend", widgets: [] });
  try {
    assert.deepEqual(await store.getDashboard(PROJECT, cost.id, db), before);
    assert.deepEqual(await ensureDefaultDashboards(PROJECT, db), []);
  } finally {
    Object.assign(COST_TEMPLATE, original);
  }

  assert.ok((await change({ action: "rename", dashboardId: cost.id, name: "Our spend" })).ok);
  const [first] = before.widgets.filter(isWidget);
  const edited = { title: "Renamed widget", query: first.query, chart: first.chart };
  assert.ok(
    (
      await change({
        action: "edit-widget",
        dashboardId: cost.id,
        widgetId: first.id,
        widget: edited,
      })
    ).ok,
  );
  const after = await store.getDashboard(PROJECT, cost.id, db);
  assert.equal(after?.name, "Our spend");
  assert.equal(after?.widgets.find(({ id }) => id === first.id)?.title, "Renamed widget");
  assert.equal(after?.updatedByName, "Ada");
  assert.ok((await change({ action: "delete", dashboardId: cost.id })).ok);
  assert.deepEqual(await names(), ["Tools", "Reliability"]);
});

test("a dashboard from a template is made and stored as a kept signal of Ask", async () => {
  const made = await change({ action: "create-template", template: "quality" });
  assert.ok(made.ok);
  const dashboard = await store.getDashboard(PROJECT, made.dashboardId, db);
  assert.equal(dashboard?.name, "Quality");
  assert.equal(dashboard?.updatedByName, "Ada");
  assert.deepEqual(await listTemplatePicks(PROJECT, 10, db), ["quality"]);
  assert.deepEqual(await listTemplatePicks(OTHER, 10, db), []);

  const input = await loadSuggestInput(PROJECT, { target: "dashboard", dashboardId: null }, db);
  const quality = DASHBOARD_TEMPLATES.find(({ id }) => id === "quality");
  assert.ok(
    input.earlierAsks.some(({ words, outcome }) => outcome === "kept" && words === quality?.prompt),
  );
  // The starter is the template Traces overview, and an unknown template is refused.
  assert.ok((await change({ action: "create-starter" })).ok);
  assert.deepEqual(await change({ action: "create-template", template: "nope" }), {
    ok: false,
    error: 'There is no dashboard template "nope".',
  });
});

test("templates whose data the project has are candidates of the suggested prompts", async () => {
  const target = { target: "dashboard" as const, dashboardId: null };
  const empty = buildCandidates(await loadSuggestInput(PROJECT, target, db));
  assert.deepEqual(
    empty.filter(({ topic }) => topic === "template"),
    [],
  );
  await seed(PROJECT);
  const seeded = buildCandidates(await loadSuggestInput(PROJECT, target, db));
  const templates = seeded.filter(({ topic }) => topic === "template").map(({ id }) => id);
  assert.ok(templates.length > 0);
  assert.ok(templates.every((id) => id.startsWith("template:")));
  // A template whose dashboard the project has is no suggestion.
  assert.ok((await change({ action: "create-template", template: "tools" })).ok);
  const after = buildCandidates(await loadSuggestInput(PROJECT, target, db));
  assert.ok(!after.some(({ id }) => id === "template:tools"));
});

test("By customer takes an indexed property of the project, never another project's", async () => {
  await client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${OTHER}', 'plan', 'indexed', 'user', 5),
      ('${PROJECT}', 'region', 'detected', 'user', 5);`);
  const refused = await change({
    action: "create-template",
    template: "by-customer",
    property: "plan",
  });
  assert.deepEqual(refused.ok, false);
  assert.match(!refused.ok ? refused.error : "", /The property plan is not indexed/);
  const detected = await change({
    action: "create-template",
    template: "by-customer",
    property: "region",
  });
  assert.match(!detected.ok ? detected.error : "", /The property region is not indexed/);
  assert.match(
    (await change({ action: "create-template", template: "by-customer" })).ok ? "" : "refused",
    /refused/,
  );

  await client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 5);`);
  const made = await change({
    action: "create-template",
    template: "by-customer",
    property: "plan",
  });
  assert.ok(made.ok);
  assert.equal(
    (await store.getDashboard(PROJECT, made.dashboardId, db))?.name,
    "By customer: plan",
  );
});

test("the data check says what each template lacks on an empty project and has on a seeded one", async () => {
  const empty = await loadTemplateFacts(PROJECT, db);
  const lacks = Object.fromEntries(
    DASHBOARD_TEMPLATES.map((template) => [template.id, templateData(template, empty)]),
  );
  assert.deepEqual(lacks.tools, { has: false, missing: ["No tool calls yet"] });
  assert.deepEqual(lacks.cost, { has: false, missing: ["No traces yet"] });
  assert.deepEqual(lacks.quality, { has: false, missing: ["No scorer yet"] });
  assert.deepEqual(lacks["by-customer"], {
    has: false,
    missing: ["No indexed trace property yet"],
  });
  assert.ok(Object.values(lacks).every(({ has }) => !has));

  await seed(PROJECT);
  await client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 5);`);
  const seeded = await loadTemplateFacts(PROJECT, db);
  const has = DASHBOARD_TEMPLATES.filter((template) => templateData(template, seeded).has).map(
    ({ id }) => id,
  );
  assert.deepEqual(has, [
    "tools",
    "cost",
    "reliability",
    "traces-overview",
    "users-sessions",
    "models",
    "agents",
    "by-customer",
  ]);
  // The other project's rows are not this project's facts.
  assert.deepEqual((await loadTemplateFacts(OTHER, db)).tables, []);
});

test("every widget of every template runs on an empty and on a seeded project", async () => {
  const runner = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
    properties: (projectId) => loadStoredPropertyNames(projectId, db),
  });
  await client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 5);`);
  const until = new Date(Date.now() + 60_000);
  const window = { since: new Date(until.getTime() - 7 * 86_400_000), until };
  for (const seeded of [false, true]) {
    if (seeded) await seed(PROJECT);
    for (const template of DASHBOARD_TEMPLATES) {
      const made = templateDashboard(template.id, { property: "plan", indexed: ["plan"] });
      assert.ok(made.ok);
      for (const widget of made.widgets) {
        if (widget.query.kind !== "sql" || !isMetricChart(widget.chart)) continue;
        const text = textToRun(widget.query, widget.chart, window);
        const query = { ...widget.query, text };
        const result = await runner(PROJECT, query, window, db).catch((error: Error) => error);
        assert.ok(
          !(result instanceof Error),
          `${template.name} › ${widget.title || "widget"} (${seeded ? "seeded" : "empty"}): ${result instanceof Error ? result.message : ""}`,
        );
      }
    }
  }
});
