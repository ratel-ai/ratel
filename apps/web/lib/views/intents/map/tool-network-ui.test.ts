// The runner only picks up `.ts`, so components are built with createElement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntentMapView } from "@/components/console/intent-map/IntentMapView";
import {
  LinkExplanation,
  NetworkLegend,
  NetworkReadout,
} from "@/components/console/intent-map/NetworkChrome";
import {
  NetworkHull,
  NetworkLinkMark,
  NetworkNodeMark,
} from "@/components/console/intent-map/NetworkMarks";
import type { IntentGraphClusterSummaryRow } from "@/lib/readings/intent-graph/queries";
import type { IntentGraphEdgeRow } from "@/lib/readings/intent-graph/schema";
import { askGroupLabel } from "@/lib/views/intents/map/labels";
import { buildIntentMapModel } from "@/lib/views/intents/map/map-model";
import { buildToolNetwork, linkReasons, type ToolStep } from "@/lib/views/intents/map/tool-network";
import { linkShape } from "@/lib/views/intents/map/tool-network-layout";

const PROJECT = "p1";

/** The app router's contexts, at a URL with `search`, so the view switch reads `?view=` as it does in the app. */
function inApp(pathname: string, search: string, children: ReactNode): ReactElement {
  const router = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  return createElement(
    AppRouterContext.Provider,
    { value: router as never },
    createElement(
      PathnameContext.Provider,
      { value: pathname },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams(search) as never },
        children,
      ),
    ),
  );
}

function cluster(over: Partial<IntentGraphClusterSummaryRow>): IntentGraphClusterSummaryRow {
  return {
    projectId: PROJECT,
    graphKey: "cloud",
    clusterId: "intent_0",
    label: "create a task",
    labelOverride: null,
    terms: [],
    memberCount: 3,
    support: 10,
    seededSupport: 0,
    lastTs: null,
    hasCentroid: false,
    ...over,
  };
}

function edge(over: Partial<IntentGraphEdgeRow>): IntentGraphEdgeRow {
  return {
    projectId: PROJECT,
    graphKey: "cloud",
    clusterId: "intent_0",
    kind: "tool",
    capabilityId: "x",
    weight: 1,
    surfaced: null,
    ...over,
  };
}

// Raw user queries as group labels: they may be text, never an attribute.
const CLUSTERS = [
  cluster({ clusterId: "intent_61", label: "find the customer for jane@acme.io", support: 36 }),
  cluster({ clusterId: "intent_80", label: "refund order 1042 for jane", support: 14 }),
  cluster({ clusterId: "intent_67", label: "where is order 1042?", support: 91 }),
  cluster({ clusterId: "intent_64", label: "review my pull request", support: 55 }),
  cluster({ clusterId: "intent_77", label: "why did the deploy fail", support: 18 }),
  cluster({ clusterId: "intent_78", label: "open a branch for the fix", support: 9 }),
  cluster({ clusterId: "intent_63", label: "search the code for retry", support: 62 }),
];
const EDGES = [
  edge({ clusterId: "intent_61", capabilityId: "stripe_search_customers", weight: 22 }),
  edge({ clusterId: "intent_61", capabilityId: "stripe_get_customer", weight: 14 }),
  edge({ clusterId: "intent_80", capabilityId: "stripe_get_customer", weight: 2 }),
  edge({ clusterId: "intent_80", capabilityId: "stripe_refund_charge", weight: 12 }),
  edge({ clusterId: "intent_67", capabilityId: "lookup_order", weight: 86 }),
  edge({ clusterId: "intent_67", capabilityId: "stripe_list_invoices", weight: 5 }),
  edge({ clusterId: "intent_64", capabilityId: "github_api", weight: 33 }),
  edge({ clusterId: "intent_64", kind: "skill", capabilityId: "review-pull-request", weight: 22 }),
  edge({ clusterId: "intent_77", capabilityId: "github_api", weight: 14 }),
  edge({ clusterId: "intent_77", capabilityId: "vercel_get_deployment_logs", weight: 4 }),
  edge({ clusterId: "intent_78", capabilityId: "github_api", weight: 9 }),
  edge({ clusterId: "intent_63", capabilityId: "github_api", weight: 5 }),
  edge({ clusterId: "intent_63", capabilityId: "ripgrep", weight: 57 }),
];
const MISSING = new Set(["tool:stripe_list_invoices"]);
const STEPS: ToolStep[] = [
  { from: "tool:lookup_order", to: "tool:stripe_refund_charge", n: 12, of: 30 },
];

function labels(): string[] {
  return CLUSTERS.flatMap((item) => [
    item.label,
    askGroupLabel({ label: item.label, terms: item.terms }),
  ]);
}

/** Every attribute value in the markup. */
function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)].map(
    ([, , value]) => value,
  );
}

function assertNoLabelInAttributes(html: string) {
  for (const value of attributeValues(html)) {
    for (const label of labels()) {
      assert.ok(
        !value.toLowerCase().includes(label.toLowerCase()),
        `an attribute carries "${label}": ${value}`,
      );
    }
  }
}

function model() {
  return buildIntentMapModel({ clusters: CLUSTERS, edges: EDGES, missing: MISSING });
}

/** The map with its controls at `?view=`, as Intents › Map renders it. */
function renderMap(search: string, steps: readonly ToolStep[] | undefined): string {
  const view = new URLSearchParams(search).get("view");
  return renderToStaticMarkup(
    inApp(
      `/project/${PROJECT}/intents/map`,
      search,
      createElement(IntentMapView, {
        model: model(),
        steps,
        selectedId: null,
        onOpen: () => {},
        onClear: () => {},
        layout: view === "tools" ? "tools" : view === "flow" ? "flow" : "map",
        onLayoutChange: () => {},
      }),
    ),
  );
}

const svg = (children: ReactNode) => renderToStaticMarkup(createElement("svg", null, children));

test("?view=tools opens the Tools view: a third choice beside Map and Flow, with its own find and zoom", () => {
  const html = renderMap("view=tools", STEPS);
  assert.match(html, /data-intent-map-view="tools"/);
  assert.match(html, /aria-label="View"/);
  for (const name of ["Map", "Flow", "Tools"]) assert.match(html, new RegExp(`>${name}</button>`));
  assert.match(
    html,
    /<button(?=[^>]*aria-pressed="true")[^>]*>Tools<\/button>/,
    "Tools is the pressed choice",
  );
  assert.match(html, /aria-label="Find a tool"/);
  assert.doesNotMatch(
    html,
    /aria-label="Find an intent or tool"/,
    "intents are not in this drawing",
  );
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(
    html,
    /data-tool-network="" data-state="measuring"/,
    "the drawing waits for the browser",
  );
  assert.match(html, /aria-live="polite"/, "the readout is announced");
  assert.match(html, /aria-label="Legend"/);
  assert.match(html, />Run together</, "without tasks, the hues are the tools that run together");
  assert.match(html, />Widely shared</, "and the hub's ring");
  assert.doesNotMatch(html, /\btopics?\b/i, "the product's word is intent");
  assert.match(html, />Came next</, "and the arrow, since a step is known");
  assert.match(html, />Not in catalog</);
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
  assertNoLabelInAttributes(html);
});

test("without a step reading, the legend has no arrow and the map view is unchanged", () => {
  const html = renderMap("view=tools", undefined);
  assert.doesNotMatch(html, />Came next</);
  const map = renderMap("", undefined);
  assert.match(map, /data-intent-map-view="map"/);
  assert.match(map, /data-intent-map="" data-state="measuring"/);
});

test("a tool is named by its id and numbers in attributes; a missing one is dashed, never outlined in amber", () => {
  const network = buildToolNetwork({ model: model(), steps: STEPS });
  const invoices = network.nodes.find((node) => node.id === "tool:stripe_list_invoices")!;
  const group = network.groups.find((item) => item.id === invoices.group)!;
  assert.ok(group.color, "it is in a colored group");
  const html = svg(
    createElement(NetworkNodeMark, {
      node: invoices,
      mark: { x: 10, y: 10, r: 6 },
      color: group.color,
      state: "rest",
      tabIndex: 0,
      onHover: () => {},
      onFocus: () => {},
      onBlur: () => {},
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onClick: () => {},
    }),
  );
  assert.match(html, /data-node="tool:stripe_list_invoices"/);
  assert.match(html, /role="button"/);
  assert.match(
    html,
    /aria-label="stripe_list_invoices, tool: 5 calls across 1 intent, linked to \d+ tools?, not in your catalog"/,
  );
  assert.match(html, /stroke-dasharray:2_2/, "dashed");
  assert.match(
    html,
    new RegExp(`stroke-${group.color}`),
    "in its group's hue, so membership still reads",
  );
  assert.doesNotMatch(html, /stroke-warning/, "the problem is a badge, never an amber outline");
  assertNoLabelInAttributes(html);

  const hub = network.nodes.find((node) => node.id === "tool:github_api")!;
  assert.equal(hub.hub, true);
  const hubHtml = svg(
    createElement(NetworkNodeMark, {
      node: hub,
      mark: { x: 10, y: 10, r: 9 },
      color: null,
      state: "selected",
      tabIndex: -1,
      onHover: () => {},
      onFocus: () => {},
      onBlur: () => {},
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onClick: () => {},
    }),
  );
  assert.match(hubHtml, /data-hub="true"/);
  assert.match(hubHtml, /aria-label="github_api, tool: [^"]*widely shared"/);
  assert.match(hubHtml, /aria-pressed="true"/);
  assert.match(hubHtml, /stroke-accent-mark/, "the open tool wears the coral ring");
  assert.doesNotMatch(hubHtml, /fill-chart-/, "a hub is neutral");
});

test("why two tools are linked is written as text beside the link and in the readout, never in an attribute", () => {
  const map = model();
  const network = buildToolNetwork({ model: map, steps: STEPS });
  const pair = network.links.find((link) => link.shared.includes("intent_61"))!;
  const nameOf = (id: string) => network.nodes.find((node) => node.id === id)?.name ?? id;
  const labelOf = (id: string) => map.asks.find((ask) => ask.id === id)?.label ?? null;
  const reasons = linkReasons(pair, nameOf, labelOf);
  assert.match(reasons[0]!, /^Both serve the same intent: Find the customer for jane@acme\.io\.$/);

  const explanation = renderToStaticMarkup(
    createElement(LinkExplanation, {
      names: [nameOf(pair.source), nameOf(pair.target)],
      reasons,
      anchor: { x: 300, y: 200 },
      avoid: [],
      view: { width: 900, height: 500 },
    }),
  );
  assert.match(
    explanation,
    /aria-hidden="true"/,
    "the readout announces it; this one is for the eye",
  );
  assert.match(explanation, /Find the customer for jane@acme\.io/);
  assertNoLabelInAttributes(explanation);

  const readout = renderToStaticMarkup(
    createElement(NetworkReadout, {
      readout: {
        kind: "link",
        link: pair,
        names: [nameOf(pair.source), nameOf(pair.target)],
        reasons,
      },
      totals: { tools: network.nodes.length, links: network.links.length, shown: 1 },
    }),
  );
  assert.match(readout, /aria-live="polite"/);
  assert.match(readout, /Find the customer for jane@acme\.io/);
  assertNoLabelInAttributes(readout);

  const step = network.links.find((link) => link.directed)!;
  assert.deepEqual(linkReasons(step, nameOf, labelOf), [
    "stripe_refund_charge came next after lookup_order in 12 of 30 calls.",
  ]);
  const shape = linkShape({ x: 0, y: 0, r: 8 }, { x: 120, y: 40, r: 6 }, true)!;
  const linkHtml = svg(
    createElement(NetworkLinkMark, {
      link: step,
      shape,
      color: null,
      tone: "rest",
      onHover: () => {},
    }),
  );
  assert.match(linkHtml, /data-link="tool:lookup_order\|tool:stripe_refund_charge"/);
  assert.match(linkHtml, /data-directed="true"/);
  assert.equal(
    linkHtml.match(/<path/g)?.length,
    3,
    "the curve, its arrowhead, and the wider stroke that takes the pointer",
  );
  assertNoLabelInAttributes(linkHtml);
  for (const text of [...reasons, ...linkReasons(step, nameOf, labelOf)])
    assert.doesNotMatch(text, /\u2014/);
});

test("a group's hull wears its hue; text never does, and the legend's warning is a triangle", () => {
  const hull = svg(
    createElement(NetworkHull, {
      id: "g1",
      path: "M0,0L10,0L10,10Z",
      color: "chart-5",
      state: "rest",
    }),
  );
  assert.match(hull, /data-hull="g1"/);
  assert.match(hull, /fill-chart-5\/10/, "a faint tint");
  assert.match(hull, /stroke-chart-5/);
  const legend = renderToStaticMarkup(
    createElement(NetworkLegend, {
      groups: true,
      hubs: true,
      ordered: true,
      missing: true,
      skills: true,
    }),
  );
  assert.match(
    legend,
    /<path d="M9,4\.5L13\.5,12\.5L4\.5,12\.5Z" class="fill-warning"/,
    "a warning triangle",
  );
  assert.doesNotMatch(legend, /<circle[^>]*class="fill-none stroke-warning"/, "not an amber ring");
  for (const part of [hull, legend]) {
    for (const [, classes] of part.matchAll(/<text[^>]*class="([^"]*)"/g))
      assert.doesNotMatch(classes!, /chart-/, "text wears text tokens");
  }
  assert.match(legend, /text-fg-subtle/);
  for (const name of [
    "Tool",
    "Skill",
    "Task",
    "Shared by many tasks",
    "Came next",
    "Not in catalog",
  ])
    assert.match(legend, new RegExp(`>${name}</li>`));
});
