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
import { ribbonOpacity } from "@/components/console/intent-map/IntentFlow";
import { IntentMapView } from "@/components/console/intent-map/IntentMapView";
import { LENS_DESCRIPTIONS } from "@/components/console/intent-map/lens-descriptions";
import { IntentCard, MapLegend, MapReadout } from "@/components/console/intent-map/MapChrome";
import { MapLensDescription } from "@/components/console/intent-map/MapLensDescription";
import { Mark, ToolLines } from "@/components/console/intent-map/MapMarks";
import { NetworkReadout } from "@/components/console/intent-map/NetworkChrome";
import {
  HomeLabel,
  NetworkGlobe,
  NetworkHull,
  NetworkNodeMark,
} from "@/components/console/intent-map/NetworkMarks";
import { middleCut, networkLabels } from "@/components/console/intent-map/network-labels";
import { descriptionHref, TaskColors } from "@/components/console/intents/TopicsMapView";
import { toolMarks } from "@/lib/views/intents/map/map-marks";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { buildToolNetwork } from "@/lib/views/intents/map/tool-network";
import { cardSpot } from "@/lib/views/intents/map/tool-network-layout";

const PROJECT = "p1";

/** The app router's contexts, at a URL with `search`, so client links and `?view=` read as they do in the app. */
function inApp(search: string, children: ReactNode): ReactElement {
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
      { value: `/project/${PROJECT}/intents/map` },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams(search) as never },
        children,
      ),
    ),
  );
}

// Intent names come from people's asks, task names are model-written: text only, never an attribute.
const NAMES = [
  "Where is order 1042 for jane@acme.io",
  "Rent a scissor lift",
  "Track an order",
  "Notify the team",
];

function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)].map(
    ([, , value]) => value,
  );
}

function assertNoNamesInAttributes(html: string) {
  for (const value of attributeValues(html)) {
    for (const name of NAMES)
      assert.ok(
        !value.toLowerCase().includes(name.toLowerCase()),
        `an attribute carries "${name}": ${value}`,
      );
  }
}

function assertProductWords(html: string) {
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
  assert.doesNotMatch(
    html,
    /\btopics?\b|ask group|workflow|Tool craft|suggestion|signal/i,
    "the product's nouns only",
  );
}

function model(): IntentMapModel {
  return {
    asks: [
      {
        id: "t_order",
        label: NAMES[0]!,
        volume: 60,
        phrasings: 4,
        firstTry: null,
        rankedByGraph: 0,
        problem: null,
        tint: "chart-1",
      },
      {
        id: "t_rent",
        label: NAMES[1]!,
        volume: 30,
        phrasings: 2,
        firstTry: null,
        rankedByGraph: 0,
        problem: { kind: "unanswered", rate: 0.9 },
        tint: null,
      },
    ],
    capabilities: [
      {
        id: "tool:lookup_order",
        kind: "tool",
        name: "lookup_order",
        calls: 70,
        asks: 2,
        missing: false,
        tint: "chart-1",
        task: "wf_track",
      },
      {
        id: "tool:notify_team",
        kind: "tool",
        name: "notify_team",
        calls: 9,
        asks: 1,
        missing: false,
        tint: null,
        task: "wf_notify",
      },
      {
        id: "tool:get_rental_quote",
        kind: "tool",
        name: "get_rental_quote",
        calls: 4,
        asks: 1,
        missing: true,
        tint: null,
        task: null,
      },
    ],
    links: [
      { ask: "t_order", capability: "tool:lookup_order", weight: 62, share: 0.87 },
      { ask: "t_order", capability: "tool:notify_team", weight: 9, share: 0.13 },
      { ask: "t_rent", capability: "tool:lookup_order", weight: 8, share: 0.67 },
      { ask: "t_rent", capability: "tool:get_rental_quote", weight: 4, share: 0.33 },
    ],
    hidden: null,
    tasks: [
      { id: "wf_track", name: NAMES[2]!, slot: "chart-1", runs: 200, steps: ["tool:lookup_order"] },
      { id: "wf_notify", name: NAMES[3]!, slot: null, runs: 20, steps: ["tool:notify_team"] },
    ],
  };
}

const handlers = { onHover: () => {}, onOpen: () => {}, onFocus: () => {}, onBlur: () => {} };
const svg = (children: ReactNode) => renderToStaticMarkup(createElement("svg", null, children));

test("the page says what the drawing is, per lens, in one sentence", () => {
  for (const [search, sentence] of [
    ["", LENS_DESCRIPTIONS.map],
    ["view=flow", LENS_DESCRIPTIONS.flow],
    ["view=tools", LENS_DESCRIPTIONS.tools],
  ] as const) {
    assert.equal(renderToStaticMarkup(inApp(search, createElement(MapLensDescription))), sentence);
  }
  assert.equal(LENS_DESCRIPTIONS.map, "Each blob is an intent, holding the tools its asks used.");
});

test("the map's controls, readout and legend say intent; the legend names the shared mark and the task colors", () => {
  const html = renderToStaticMarkup(
    inApp(
      "",
      createElement(IntentMapView, {
        model: model(),
        selectedId: null,
        onOpen: () => {},
        onClear: () => {},
        layout: "map",
        onLayoutChange: () => {},
      }),
    ),
  );
  assert.match(html, /aria-label="Find an intent or tool"/);
  assert.match(html, /placeholder="Find an intent or tool…"/);
  assert.match(html, />2 intents</);
  assert.match(html, />3 tools</);
  assertProductWords(html);
  assertNoNamesInAttributes(html);

  const legend = renderToStaticMarkup(
    createElement(MapLegend, {
      problem: { kind: "unanswered", rate: 0.9 },
      tinted: true,
      missing: true,
      skills: false,
      shared: true,
    }),
  );
  for (const word of [
    "Intent",
    "Tool",
    "In several intents",
    "Task",
    "Not in catalog",
    "Mostly unanswered",
  ])
    assert.match(legend, new RegExp(`${word}</li>`));
  assertProductWords(legend);
});

test("the readout leads with the noun's icon and counts asks, tools and intents", () => {
  const { asks, capabilities } = model();
  const rest = renderToStaticMarkup(
    createElement(MapReadout, {
      readout: null,
      hidden: { asks: 3, volume: 12 },
      totals: { asks: 2, capabilities: 3 },
    }),
  );
  assert.match(rest, />2 intents</);
  assert.match(rest, />3 quieter intents in All intents</);
  assert.match(rest, /lucide-message-square-text/, "the intent's icon");
  const ask = renderToStaticMarkup(
    createElement(MapReadout, {
      readout: { kind: "ask", ask: asks[1]!, tools: 2 },
      hidden: null,
      totals: { asks: 2, capabilities: 3 },
    }),
  );
  assert.match(
    ask,
    /Rent a scissor lift<\/span><span[^>]*>30 asks<\/span><span[^>]*>2 tools<\/span>/,
  );
  assert.match(ask, />Mostly unanswered</);
  const tool = renderToStaticMarkup(
    createElement(MapReadout, {
      readout: { kind: "capability", capability: capabilities[0]! },
      hidden: null,
      totals: { asks: 2, capabilities: 3 },
    }),
  );
  assert.match(tool, />lookup_order<\/span><span[^>]*>70 calls<\/span><span[^>]*>2 intents</);
  assert.match(tool, /lucide-wrench/, "the tool's icon");
  for (const html of [rest, ask, tool]) {
    assert.match(html, /aria-live="polite"/);
    assertNoNamesInAttributes(html);
    assertProductWords(html);
  }
});

test("a tool's mark in an intent is named by ids and numbers; a shared one wears its ring", () => {
  const source = model();
  const marks = toolMarks(source);
  const shared = marks.byAsk
    .get("t_rent")!
    .find((mark) => mark.capability === "tool:lookup_order")!;
  const own = marks.byAsk
    .get("t_rent")!
    .find((mark) => mark.capability === "tool:get_rental_quote")!;
  const node = {
    id: shared.id,
    kind: "tool" as const,
    x: 10,
    y: 10,
    r: 5,
    membership: "single" as const,
    placement: "inside" as const,
    groups: ["t_rent"],
    angle: null,
  };
  const html = svg(
    createElement(Mark, {
      capability: source.capabilities[0]!,
      mark: shared,
      node,
      state: "rest",
      tabIndex: 0,
      ...handlers,
    }),
  );
  assert.match(html, /data-node="tool:lookup_order@t_rent"/);
  assert.match(html, /data-tool="tool:lookup_order"/);
  assert.match(html, /data-shared="true"/);
  assert.match(html, /data-shared-ring=""/);
  assert.match(
    html,
    /aria-label="lookup_order, tool: 8 calls in intent t_rent, shared by 2 intents"/,
  );
  assert.match(html, /fill-chart-1/, "its task's color");
  const lone = svg(
    createElement(Mark, {
      capability: source.capabilities[2]!,
      mark: own,
      node: { ...node, id: own.id },
      state: "rest",
      tabIndex: -1,
      ...handlers,
    }),
  );
  assert.doesNotMatch(lone, /data-shared/);
  assert.match(
    lone,
    /aria-label="get_rental_quote, tool: 4 calls in intent t_rent, not in your catalog"/,
  );
  assert.match(lone, /stroke-dasharray:2_2/, "dashed when the catalog lost it");
  for (const part of [html, lone]) assertNoNamesInAttributes(part);
});

test("pointing at a tool draws a line with an arrowhead to each other intent it serves, in its task's color", () => {
  const html = svg(
    createElement(ToolLines, {
      from: { x: 0, y: 0, r: 5 },
      to: [
        { x: 200, y: 40, r: 4 },
        { x: -150, y: 120, r: 6 },
      ],
      tint: "chart-1",
    }),
  );
  assert.match(html, /data-tool-lines=""/);
  assert.match(html, /aria-hidden="true"/);
  assert.equal(html.match(/<path/g)?.length, 4, "a curve and an arrowhead per intent");
  assert.match(html, /stroke-chart-1/);
  const neutral = svg(
    createElement(ToolLines, {
      from: { x: 0, y: 0, r: 5 },
      to: [{ x: 200, y: 40, r: 4 }],
      tint: null,
    }),
  );
  assert.match(neutral, /stroke-fg-muted/);
});

test("an intent's card lists its tools as pins with their calls, a shared one marked, the rest counted", () => {
  const source = model();
  const marks = toolMarks({
    ...source,
    links: [
      ...source.links,
      ...Array.from({ length: 6 }, (_, index) => ({
        ask: "t_order",
        capability: `tool:extra_${index}`,
        weight: 1,
        share: 0,
      })),
    ],
  });
  const capabilities = new Map([
    ...source.capabilities.map((capability) => [capability.id, capability] as const),
    ...Array.from(
      { length: 6 },
      (_, index) =>
        [
          `tool:extra_${index}`,
          {
            id: `tool:extra_${index}`,
            kind: "tool" as const,
            name: `extra_${index}`,
            calls: 1,
            asks: 1,
            missing: false,
          },
        ] as const,
    ),
  ]);
  const html = renderToStaticMarkup(
    createElement(IntentCard, {
      ask: source.asks[0]!,
      marks: marks.byAsk.get("t_order")!,
      capabilities,
      blob: { left: 100, top: 80, width: 160, height: 140 },
      view: { width: 900, height: 500 },
    }),
  );
  assert.match(html, /data-intent-card=""/);
  assert.match(html, /aria-hidden="true"/, "the readout announces it; the card is for the eye");
  assert.match(html, /Where is order 1042 for jane@acme\.io<\/span><span[^>]*>60 asks</);
  assert.match(html, /lucide-wrench/, "tools as pins");
  assert.match(html, />lookup_order<\/span>/);
  assert.match(html, />62</);
  assert.match(html, /and 2 more tools/);
  assertNoNamesInAttributes(html);
  assertProductWords(html);
});

test("the task colors are named under the drawing as pins that open the task", () => {
  const html = renderToStaticMarkup(
    inApp("", createElement(TaskColors, { projectId: PROJECT, model: model() })),
  );
  assert.match(html, /data-task-colors=""/);
  assert.match(html, /href="\/project\/p1\/health\/tasks\/wf_track"/);
  assert.match(html, />Track an order<\/span>/);
  assert.match(html, /bg-chart-1/);
  assert.match(html, />Other tasks</);
  assert.match(html, /Task colors/, "named for screen readers");
  assertNoNamesInAttributes(html);
  const none = renderToStaticMarkup(
    inApp(
      "",
      createElement(TaskColors, {
        projectId: PROJECT,
        model: { ...model(), asks: [], capabilities: [] },
      }),
    ),
  );
  assert.equal(none, "", "nothing colored, nothing to name");
  assert.equal(
    descriptionHref("p 1", "skill:review"),
    "/project/p%201/quality/descriptions?tool=skill%3Areview",
  );
});

test("the globe: a disc, the dashed ring for tools in no task, hulls by home, and homes named like pins", () => {
  const globe = svg(
    createElement(NetworkGlobe, { disc: { x: 0, y: 0, r: 200 }, ring: { x: 0, y: 0, r: 240 } }),
  );
  assert.match(globe, /data-globe=""/);
  assert.match(globe, /data-ring=""/);
  assert.match(globe, /stroke-dasharray:3_5/);
  assert.doesNotMatch(
    svg(createElement(NetworkGlobe, { disc: { x: 0, y: 0, r: 200 }, ring: null })),
    /data-ring/,
  );

  const neutral = svg(
    createElement(NetworkHull, {
      id: "task:wf_notify",
      path: "M0,0L10,0L10,10Z",
      color: "neutral",
      state: "rest",
    }),
  );
  assert.match(neutral, /data-tone="neutral"/);
  assert.match(neutral, /stroke-line-strong/);
  const shared = svg(
    createElement(NetworkHull, {
      id: "shared",
      path: "M0,0L10,0L10,10Z",
      color: "shared",
      state: "rest",
    }),
  );
  assert.match(shared, /stroke-dasharray:4_3/);

  const task = svg(
    createElement(HomeLabel, {
      kind: "task",
      color: "chart-1",
      text: "Track an order",
      x: 10,
      y: 10,
      state: "rest",
    }),
  );
  assert.match(task, /data-home-label="task"/);
  assert.match(task, /<rect[^>]*class="fill-chart-1"/, "the task's color square");
  assert.match(task, />Track an order<\/text>/);
  assert.match(
    svg(
      createElement(HomeLabel, {
        kind: "task",
        color: null,
        text: "Notify the team",
        x: 10,
        y: 10,
        state: "rest",
      }),
    ),
    /fill-fg-subtle/,
    "gray past the colored three",
  );
  assert.match(
    svg(
      createElement(HomeLabel, {
        kind: "shared",
        color: null,
        text: "Shared",
        x: 0,
        y: 0,
        state: "lit",
      }),
    ),
    />Shared<\/text>/,
  );
  assert.match(
    svg(
      createElement(HomeLabel, {
        kind: "other",
        color: null,
        text: "No task",
        x: 0,
        y: 0,
        state: "dim",
      }),
    ),
    /opacity-40/,
  );
  for (const html of [task, neutral, shared]) {
    assertNoNamesInAttributes(html);
    for (const [, classes] of html.matchAll(/<text[^>]*class="([^"]*)"/g))
      assert.doesNotMatch(classes!, /chart-/, "text wears text tokens");
  }
});

test("a tool's home shows in its mark's name and the readout: shared by many tasks, in no task, or its task by name", () => {
  const network = buildToolNetwork({ model: model() });
  const node = network.nodes.find((item) => item.id === "tool:lookup_order")!;
  const mark = svg(
    createElement(NetworkNodeMark, {
      node,
      mark: { x: 10, y: 10, r: 8 },
      color: "chart-1",
      home: "shared",
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
  assert.match(mark, /data-home="shared"/);
  assert.match(mark, /data-hub="true"/, "a shared tool wears the ring");
  assert.match(
    mark,
    /aria-label="lookup_order, tool: 70 calls across 2 intents, linked to \d+ tools?, shared by many tasks"/,
  );
  const readout = (home: { kind: "task" | "shared" | "other"; name: string }) =>
    renderToStaticMarkup(
      createElement(NetworkReadout, {
        readout: { kind: "node", node, partners: [], home },
        totals: { tools: 3, links: 2, shown: 1, tasks: 2 },
      }),
    );
  assert.match(readout({ kind: "task", name: "Track an order" }), />Track an order<\/span>/);
  assert.match(readout({ kind: "shared", name: "Shared" }), />Shared by many tasks</);
  assert.match(readout({ kind: "other", name: "No task" }), />No task</);
  const totals = renderToStaticMarkup(
    createElement(NetworkReadout, {
      readout: null,
      totals: { tools: 3, links: 6, shown: 2, tasks: 2 },
    }),
  );
  assert.match(totals, />3 tools<\/span>/);
  assert.match(totals, />2 tasks<\/span>/);
  assert.match(totals, /2 of 6 links/);
  for (const html of [mark, totals]) {
    assertNoNamesInAttributes(html);
    assertProductWords(html);
  }
});

test("the Tools lens says where every tool lives: by task, Shared, and No task, in its legend and readout", () => {
  const html = renderToStaticMarkup(
    inApp(
      "view=tools",
      createElement(IntentMapView, {
        model: model(),
        selectedId: null,
        onOpen: () => {},
        onClear: () => {},
        layout: "tools",
        onLayoutChange: () => {},
      }),
    ),
  );
  assert.match(html, />Task<\/li>/);
  assert.match(html, />No task<\/li>/);
  assert.match(html, />2 tasks<\/span>/);
  assertProductWords(html);
  assertNoNamesInAttributes(html);
});

test("names cut in the middle keep whole words from both ends; a short one stays whole", () => {
  assert.equal(middleCut("sync_session_workflow"), "sync…workflow");
  assert.equal(middleCut("claim_task_and_branch"), "claim_task…branch");
  assert.equal(middleCut("link_document_to_project"), "link…to_project");
  assert.equal(middleCut("list_projects"), "list_projects");
  assert.equal(middleCut("abcdefghijklmnopqrstuvwxyz"), "abcdefghi…stuvwxyz");
  assert.ok(middleCut("get_subcontractor_compliance").length <= 18);
});

test("an intent's card sits beside its blob, on the side with room, inside the canvas", () => {
  const view = { width: 900, height: 500 };
  const size = { width: 256, height: 180 };
  assert.deepEqual(
    cardSpot({ left: 100, top: 100, width: 120, height: 100 }, size, view),
    { left: 232, top: 60 },
    "right of a blob in the left half",
  );
  assert.deepEqual(
    cardSpot({ left: 600, top: 100, width: 120, height: 100 }, size, view),
    { left: 332, top: 60 },
    "left of a blob in the right half",
  );
  const phone = cardSpot({ left: 40, top: 40, width: 300, height: 120 }, size, {
    width: 360,
    height: 520,
  });
  assert.deepEqual(phone, { left: 62, top: 172 }, "below it when neither side has room");
});

test("a ribbon's quiet grows with how thin it is", () => {
  assert.ok(ribbonOpacity(1, true) < ribbonOpacity(14, true));
  assert.ok(
    ribbonOpacity(1, false) < ribbonOpacity(1, true),
    "a gray ribbon stays quieter than a colored one",
  );
  assert.equal(ribbonOpacity(40, true), ribbonOpacity(14, true), "past a width it reads in full");
});

test("a tool's name is whole where it fits, cut in its middle on its own side only where it does not", () => {
  const node = (id: string, name: string) => ({
    id,
    kind: "tool" as const,
    name,
    calls: 10,
    asks: 1,
    missing: false,
    partners: 1,
    hub: false,
    group: null,
  });
  const network = { nodes: [node("a", "sync_session_workflow"), node("b", "lookup")] };
  const widths = new Map([
    ["a", "sync_session_workflow".length * 7.44],
    ["b", "lookup".length * 7.44],
  ]);
  const place = (bx: number) =>
    networkLabels({
      network,
      marks: new Map([
        ["a", { x: 100, y: 100, r: 8 }],
        ["b", { x: 100 + bx, y: 100, r: 8 }],
      ]),
      sides: new Map([
        ["a", "right" as const],
        ["b", "right" as const],
      ]),
      widths,
      view: { x: 0, y: 0, k: 1 },
      area: { width: 1000, height: 400 },
      must: [],
      also: [],
      everyName: false,
    }).find((label) => label.id === "a")!;
  const roomy = place(400);
  assert.deepEqual(
    [roomy.lines[0], roomy.anchor],
    ["sync_session_workflow", "start"],
    "room for the whole name",
  );
  const tight = place(140);
  assert.deepEqual(
    [tight.lines[0], tight.anchor],
    ["sync…workflow", "start"],
    "cut, still facing out, rather than moved to the other side",
  );
});
