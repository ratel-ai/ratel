import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStoredPattern } from "@/lib/readings/topics/patterns";
import type { StoredTopicPattern } from "@/lib/readings/topics/types";
import { FIXED_ORDER } from "@/lib/readings/trace-signals/workflows/fixed-order";
import {
  buildIntentSteps,
  buildStepsPicture,
  fixedOrderOf,
  PICTURE_DEPTH,
  pictureRows,
} from "@/lib/views/intents/topics-steps";
import type { TaskInfo } from "@/lib/views/intents/topics-view";

/** A delivery intent: 200 turns; get_purchase_order in 160, track_material_delivery in 150, notify_team in 60; search_tools is the project's helper. */
function pattern(over: Partial<StoredTopicPattern> = {}): StoredTopicPattern {
  return {
    withCalls: 190,
    tools: [
      { id: "get_purchase_order", turns: 160 },
      { id: "track_material_delivery", turns: 150 },
    ],
    runs: 140,
    inOrder: 136,
    also: [{ id: "notify_team", turns: 60 }],
    helpers: [{ id: "search_tools", turns: 180 }],
    firsts: [
      { id: "get_purchase_order", turns: 120 },
      { id: "list_projects", turns: 50 },
      { id: "track_material_delivery", turns: 10 },
      { id: "rare", turns: 3 },
    ],
    comesBefore: [
      { first: "get_purchase_order", tool: "track_material_delivery", turns: 150, together: 122 },
      { first: "list_projects", tool: "get_purchase_order", turns: 160, together: 48 },
      { first: "track_material_delivery", tool: "notify_team", turns: 60, together: 40 },
      { first: "get_purchase_order", tool: "notify_team", turns: 60, together: 38 },
      { first: "notify_team", tool: "log_note", turns: 12, together: 10 },
      { first: "log_note", tool: "archive", turns: 6, together: 6 },
    ],
    skills: { invoked: 0, offered: 0 },
    ...over,
  };
}

const TASKS: TaskInfo[] = [
  {
    id: "wf_po",
    runs: 300,
    typicalOrder: ["search_tools", "get_purchase_order", "track_material_delivery"],
  },
  {
    id: "wf_notify",
    runs: 120,
    typicalOrder: ["track_material_delivery", "notify_team", "log_note"],
  },
  { id: "wf_other", runs: 90, typicalOrder: ["list_projects", "get_project_info"] },
];

const stats = (
  over: Partial<StoredTopicPattern> = {},
  tasks = [
    { id: "wf_notify", turns: 40 },
    { id: "wf_po", turns: 120 },
  ],
) => ({
  id: "t_delivery",
  turns: 200,
  tasks,
  pattern: pattern(over),
});

test("the sentence names the pattern's tools with their shares; helpers and the occasional tools apart", () => {
  const view = buildIntentSteps({ stats: stats(), tasks: TASKS })!;
  assert.equal(view.topicId, "t_delivery");
  assert.deepEqual(
    view.sentence?.tools.map((tool) => [tool.id, tool.share]),
    [
      ["get_purchase_order", 0.8],
      ["track_material_delivery", 0.75],
    ],
    "Most of the time this intent is done with get_purchase_order 80% and track_material_delivery 75%",
  );
  assert.equal(view.sentence?.together, 140);
  assert.equal(view.sentence?.togetherShare, 0.7);
  assert.equal(view.sentence?.inOrderShare, 136 / 140);
  assert.equal(view.sentence?.fixedOrder, false, "two steps are no fixed chain by the one rule");
  assert.deepEqual(
    view.also.map((tool) => [tool.id, tool.share]),
    [["notify_team", 0.3]],
  );
  assert.deepEqual(
    view.helpers.map((tool) => [tool.id, tool.share]),
    [["search_tools", 0.9]],
  );
  assert.deepEqual(
    view.firsts.map((tool) => [tool.id, tool.share]),
    [
      ["get_purchase_order", 0.6],
      ["list_projects", 0.25],
      ["track_material_delivery", 0.05],
      ["rare", 0.015],
    ],
    "the first calls with their shares",
  );
  assert.equal(view.withCalls, 190);
});

test("the picture starts at the intent: the main path as a chain, the other usual first calls, then what comes after each, three steps deep", () => {
  const { nodes, links } = buildIntentSteps({ stats: stats(), tasks: TASKS })!.picture;
  assert.deepEqual(nodes[0], { key: "intent", toolId: null, depth: 0, parent: null, main: false });
  const at = (toolId: string) => nodes.filter((node) => node.toolId === toolId);
  assert.deepEqual(
    nodes.filter((node) => node.depth === 1).map((node) => node.toolId),
    ["get_purchase_order", "list_projects"],
    "the main path's first tool, then the other first calls over a fifth of the turns: 50 of 200 does, 3 does not",
  );
  assert.equal(at("get_purchase_order").length, 1, "a tool is drawn once");
  const into = (toolId: string) => links.find((link) => link.to === at(toolId)[0]!.key)!;
  assert.deepEqual(
    [into("get_purchase_order").kind, into("get_purchase_order").share],
    ["starts", 0.6],
  );
  assert.equal(
    into("track_material_delivery").from,
    "intent>get_purchase_order",
    "the main path is a chain",
  );
  assert.equal(into("track_material_delivery").kind, "follows");
  assert.equal(into("track_material_delivery").share, 122 / 150);
  assert.equal(into("track_material_delivery").strong, true, "81%: almost always");
  assert.equal(
    into("notify_team").from,
    "intent>get_purchase_order>track_material_delivery",
    "under the tool it most surely comes after: 67% beats 63%",
  );
  assert.equal(into("notify_team").strong, false, "67%: usually");
  assert.equal(at("notify_team")[0]!.depth, 3);
  assert.equal(at("log_note").length, 0, `${PICTURE_DEPTH} steps deep at most`);
  assert.deepEqual(
    nodes.filter((node) => node.main).map((node) => node.toolId),
    ["get_purchase_order", "track_material_delivery"],
    "the main path is the pattern's tools",
  );
  assert.equal(links.length, nodes.length - 1, "one arrow into every tool");
});

test("a main tool that also starts a few turns still hangs in the chain, under the tool before it", () => {
  // Delivery status on Site Copilot: list_projects starts 69% of the turns, get_purchase_order 29%.
  const delivery = pattern({
    tools: [
      { id: "list_projects", turns: 116 },
      { id: "get_purchase_order", turns: 165 },
      { id: "track_material_delivery", turns: 165 },
    ],
    firsts: [
      { id: "list_projects", turns: 116 },
      { id: "get_purchase_order", turns: 49 },
    ],
    comesBefore: [
      { first: "get_purchase_order", tool: "track_material_delivery", turns: 165, together: 165 },
      { first: "list_projects", tool: "get_purchase_order", turns: 165, together: 116 },
      { first: "list_projects", tool: "track_material_delivery", turns: 165, together: 116 },
      { first: "get_purchase_order", tool: "get_daily_log", turns: 13, together: 13 },
      { first: "list_projects", tool: "get_daily_log", turns: 13, together: 8 },
    ],
  });
  const picture = buildStepsPicture(delivery, 168);
  assert.deepEqual(
    picture.nodes.map((node) => node.key),
    [
      "intent",
      "intent>list_projects",
      "intent>list_projects>get_purchase_order",
      "intent>list_projects>get_purchase_order>track_material_delivery",
      "intent>list_projects>get_purchase_order>get_daily_log",
    ],
  );
  assert.deepEqual(
    picture.links.map((link) => Math.round(link.share * 100)),
    [69, 70, 100, 100],
  );
});

test("a long main path keeps to three steps: the fourth hangs under the surest earlier tool that has room", () => {
  const long = pattern({
    tools: ["a", "b", "c", "d"].map((id) => ({ id, turns: 150 })),
    firsts: [{ id: "a", turns: 150 }],
    comesBefore: [
      { first: "a", tool: "b", turns: 150, together: 140 },
      { first: "b", tool: "c", turns: 150, together: 140 },
      { first: "c", tool: "d", turns: 150, together: 140 },
      { first: "a", tool: "d", turns: 150, together: 120 },
    ],
  });
  assert.deepEqual(
    buildStepsPicture(long, 200).nodes.map((node) => node.key),
    ["intent", "intent>a", "intent>a>b", "intent>a>d", "intent>a>b>c"],
  );
  const unreached = buildStepsPicture({ ...long, comesBefore: long.comesBefore.slice(0, 3) }, 200);
  assert.equal(
    unreached.nodes.some((node) => node.toolId === "d"),
    false,
    "no room and no turn starts with it: left out",
  );
});

test("a pattern tool no arrow reaches starts its own branch, whatever its share", () => {
  const picture = buildStepsPicture(pattern({ comesBefore: [] }), 200);
  assert.deepEqual(
    picture.nodes.filter((node) => node.depth === 1).map((node) => [node.toolId, node.main]),
    [
      ["get_purchase_order", true],
      ["track_material_delivery", true],
      ["list_projects", false],
    ],
  );
  assert.equal(
    picture.links.find((link) => link.to === "intent>track_material_delivery")?.share,
    0.05,
  );
  assert.deepEqual(
    buildStepsPicture(pattern({ firsts: [{ id: "rare", turns: 1 }], tools: [] }), 200),
    { nodes: [], links: [] },
    "nothing reaches the bar",
  );
});

test("the main path matches the task whose steps it shares most, helpers aside, wearing that task's color", () => {
  const task = buildIntentSteps({ stats: stats(), tasks: TASKS })!.task;
  assert.deepEqual(
    task,
    { id: "wf_po", color: "chart-1", turns: 120, share: 0.6, exact: true },
    "search_tools is a helper, so the task's steps are the main path",
  );
  assert.equal(
    buildIntentSteps({ stats: stats({}, [{ id: "wf_other", turns: 30 }]), tasks: TASKS })!.task,
    null,
    "a task the intent's turns ran as, but with other steps, is no match",
  );
  const partial = buildIntentSteps({
    stats: stats({}, [{ id: "wf_notify", turns: 40 }]),
    tasks: TASKS,
  })!.task;
  assert.equal(partial, null, "one shared step of four is under half");
  assert.equal(
    buildIntentSteps({ stats: stats({ tools: [] }), tasks: TASKS })!.task,
    null,
    "no main path, no task",
  );
  assert.equal(
    buildIntentSteps({ stats: stats(), tasks: [] })!.task,
    null,
    "a task the latest run no longer has is not named",
  );
  assert.equal(
    buildIntentSteps({ stats: stats({}, [{ id: "wf_po", turns: 39 }]), tasks: TASKS })!.task,
    null,
    "39 of 200 turns is under a fifth: the task says nothing about the intent",
  );
  assert.equal(
    buildIntentSteps({ stats: stats({}, [{ id: "wf_po", turns: 40 }]), tasks: TASKS })!.task?.id,
    "wf_po",
  );
});

test("fixed order is the one rule over the turns that ran every step: three steps or more, nine in ten in order, twenty of them", () => {
  const three = {
    tools: [
      { id: "a", turns: 30 },
      { id: "b", turns: 30 },
      { id: "c", turns: 30 },
    ],
    runs: 28,
    inOrder: 26,
  };
  assert.equal(fixedOrderOf(three), true);
  assert.equal(
    fixedOrderOf({ ...three, runs: FIXED_ORDER.minRuns - 1, inOrder: FIXED_ORDER.minRuns - 1 }),
    false,
    "too few turns ran them all",
  );
  assert.equal(
    fixedOrderOf({ ...three, runs: 3, inOrder: 3 }),
    false,
    "3 of 100 turns in order is no order seen",
  );
  assert.equal(fixedOrderOf({ ...three, inOrder: 24 }), false, "24 of 28 is under nine in ten");
  assert.equal(fixedOrderOf({ ...three, tools: three.tools.slice(0, 2) }), false, "two steps");
});

test("the intent keeps to three arrows of its own, and a stored pattern with a tool twice does not parse", () => {
  const scattered = pattern({
    tools: ["a", "b", "c", "d", "e"].map((id) => ({ id, turns: 120 })),
    firsts: ["a", "b", "c", "d", "e"].map((id) => ({ id, turns: 30 })),
    comesBefore: [],
  });
  const picture = buildStepsPicture(scattered, 200);
  assert.equal(picture.links.filter((link) => link.from === "intent").length, 3);
  assert.deepEqual(
    picture.nodes.filter((node) => node.depth === 1).map((node) => node.toolId),
    ["a", "b", "c"],
  );
  const twice = {
    ...pattern(),
    tools: [
      { id: "a", turns: 10 },
      { id: "a", turns: 10 },
    ],
  };
  assert.equal(parseStoredPattern(twice), null);
  assert.equal(
    parseStoredPattern({
      ...pattern(),
      comesBefore: [pattern().comesBefore[0], pattern().comesBefore[0]],
    }),
    null,
  );
  assert.deepEqual(parseStoredPattern(pattern()), pattern());
});

test("no pattern stored, nothing to say; no tool in most turns, no sentence but the picture stays", () => {
  assert.equal(buildIntentSteps({ stats: { id: "t", turns: 3, tasks: [] }, tasks: TASKS }), null);
  const loose = buildIntentSteps({
    stats: stats({ tools: [], runs: 0, inOrder: 0 }),
    tasks: TASKS,
  })!;
  assert.equal(loose.sentence, null);
  assert.ok(loose.picture.nodes.length > 1);
});

test("the picture reads top to bottom as rows: each tool under the one it comes after, the main path first", () => {
  const rows = pictureRows(buildIntentSteps({ stats: stats(), tasks: TASKS })!.picture);
  assert.deepEqual(
    rows.map(({ node, link }) => [node.toolId, node.depth, link.kind]),
    [
      ["get_purchase_order", 1, "starts"],
      ["track_material_delivery", 2, "follows"],
      ["notify_team", 3, "follows"],
      ["list_projects", 1, "starts"],
    ],
  );
  assert.deepEqual(pictureRows({ nodes: [], links: [] }), []);
});
