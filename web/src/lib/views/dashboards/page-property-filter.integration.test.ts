import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { flowQuery, funnelQuery, geographyQuery, stepFlowQuery } from "@/lib/contracts/query";
import type { FlowResult } from "@/lib/synthesis/metrics/flow";
import type { FunnelResult } from "@/lib/synthesis/metrics/funnel";
import type { GeographyResult } from "@/lib/synthesis/metrics/geography";
import type { StepFlowResult } from "@/lib/synthesis/metrics/step-flow";
import { OTHER_PROJECT, PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import { loadWidget, loadWidgets } from "@/lib/views/dashboards/data";
import { shownFilters } from "@/lib/views/dashboards/filters";
import type { WidgetInput } from "@/lib/views/dashboards/types";

/**
 * The page filter of a dashboard with a trace property (RTL-397): the address `?prop.plan=pro`
 * narrows one widget of each kind that reads traces, through the loader the page calls.
 *
 * t1 plan pro   US  search > read
 * t2 plan free  DE  search > answer
 * o1 the other project: plan pro, FR, search > read
 */

const SCOPE = { since: new Date("2026-11-02T00:00:00Z"), until: new Date("2026-11-03T00:00:00Z") };
const WIDGETS: WidgetInput[] = [
  { title: "", chart: "flow", query: flowQuery("tool") },
  { title: "", chart: "step_flow", query: stepFlowQuery("tool", { start: "none" }) },
  {
    title: "",
    chart: "funnel",
    query: funnelQuery([
      { name: "Searched", condition: { type: "tool", name: "search" } },
      { name: "No error", condition: { type: "no_error" } },
    ]),
  },
  { title: "", chart: "geography", query: geographyQuery("trace_count", "count") },
];

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const trace = (id: string, plan: string, country: string, last: string, projectId = PROJECT) => ({
    id,
    projectId,
    startedAt: "2026-11-02T09:00:00Z",
    root: { properties: { plan }, attributes: { "ratel.geo.country": country } },
    spans: [{ tool: "search" }, { tool: last }],
  });
  await database.seed([
    trace("t1", "pro", "US", "read"),
    trace("t2", "free", "DE", "answer"),
    trace("o1", "pro", "FR", "read", OTHER_PROJECT),
  ]);
  await database.client.exec(`
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${PROJECT}', 'plan', 'indexed', 'user', 2),
      ('${OTHER_PROJECT}', 'plan', 'indexed', 'user', 1);
  `);
});

after(() => database.client.close());

test("a page filter of a property narrows a widget of each kind, never to another project's traces", async () => {
  const all = await load("?range=7d");
  assert.deepEqual(summary(all), ["flow 2", "step_flow 2", "funnel 2", "geography DE 1,US 1"]);
  const pro = await load("?range=7d&prop.plan=pro");
  assert.deepEqual(summary(pro), ["flow 1", "step_flow 1", "funnel 1", "geography US 1"]);
  const team = await load("?prop.plan=team");
  assert.deepEqual(summary(team), ["flow 0", "step_flow 0", "funnel 0", "geography "]);
});

test("a page filter of a property that is not indexed is refused on each widget, with its name", async () => {
  const results = await load("?prop.tenant=a");
  for (const result of results)
    assert.deepEqual(
      {
        kind: result?.kind,
        code: (result as { code?: string }).code,
        property: (result as { property?: string }).property,
      },
      { kind: "refused", code: "property_not_indexed", property: "tenant" },
    );
});

async function load(search: string) {
  const filter = shownFilters(search, {});
  return loadWidgets(PROJECT, WIDGETS, { ...SCOPE, filter }, (projectId, widget, scope) =>
    loadWidget(projectId, widget, scope, database.db as never),
  );
}

function summary(results: readonly unknown[]): string[] {
  return results.map((result) => {
    const kind = (result as { kind: string }).kind;
    if (kind === "flow") return `flow ${(result as FlowResult).sample.matched}`;
    if (kind === "step_flow") return `step_flow ${(result as StepFlowResult).sample.matched}`;
    if (kind === "funnel") return `funnel ${(result as FunnelResult).steps[0].count}`;
    const places = (result as GeographyResult).places
      .map(({ code, value }) => `${code} ${value}`)
      .sort();
    return `geography ${places.join(",")}`;
  });
}
