import assert from "node:assert/strict";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClustersBody } from "@/components/console/dashboards/ClustersBody";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import { mapModelFrom } from "@/lib/views/intents/map/tool-network-fixture";

const NO_NAMES = { clusters: [], tools: [], skills: [], tasks: [] };

function html(change: Partial<DashboardClusters>) {
  const result: DashboardClusters = {
    kind: "clusters",
    view: "asks",
    model: mapModelFrom([["deploys", "deploy", 20]]),
    steps: [],
    analyzedAt: "2026-11-20T09:30:00.000Z",
    names: NO_NAMES,
    ...change,
  };
  const router = { push() {} } as never;
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(ClustersBody, { projectId: "p1", result }),
    ),
  );
}

test("the widget says when the analysis ran, that the time range does not apply, and links to Intents", () => {
  for (const view of ["asks", "tools"] as const) {
    const text = html({ view });
    assert.match(text, /Analysis of .*20.*09:30/);
    assert.match(text, /time range and the filters of the\s+page do not change it/);
    assert.match(text, /href="\/project\/p1\/intents\/map"/);
    assert.match(text, new RegExp(`data-clusters="${view}"`));
  }
});

test("an empty part, and no analysis, each have their own empty state", () => {
  const model = mapModelFrom([]);
  for (const view of ["asks", "tools"] as const)
    assert.match(html({ view, model }), /No cluster matches/);
  const none = html({ model, analyzedAt: null });
  assert.match(none, /No intent analysis yet/);
  assert.doesNotMatch(none, /Analysis of/);
});
