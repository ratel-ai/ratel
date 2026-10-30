import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentGraphClusterSummaryRow } from "@/lib/readings/intent-graph/queries";
import type { IntentGraphEdgeRow } from "@/lib/readings/intent-graph/schema";
import {
  askGroupName,
  buildAskRows,
  buildIntentMapModel,
  capabilityAsks,
  capabilityKey,
  compactNumber,
  firstTrySentence,
  intentFigures,
  mapLayoutKey,
  parseAskSort,
  problemRule,
  problemSentence,
  problemWord,
  splitCapabilityKey,
} from "@/lib/views/intents/map/map-model";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function cluster(over: Partial<IntentGraphClusterSummaryRow> = {}): IntentGraphClusterSummaryRow {
  return {
    projectId: PROJECT_ID,
    graphKey: "cloud",
    clusterId: "intent_0",
    label: "create a task",
    labelOverride: null,
    terms: ["create", "task"],
    memberCount: 3,
    support: 10,
    seededSupport: 0,
    lastTs: null,
    hasCentroid: false,
    ...over,
  };
}

function edge(over: Partial<IntentGraphEdgeRow> = {}): IntentGraphEdgeRow {
  return {
    projectId: PROJECT_ID,
    graphKey: "cloud",
    clusterId: "intent_0",
    kind: "tool",
    capabilityId: "acme_create_task",
    weight: 1,
    surfaced: null,
    ...over,
  };
}

const CLUSTERS = [
  cluster({ clusterId: "c-create", label: "create a task", support: 70 }),
  cluster({ clusterId: "c-status", label: "update a task's status", support: 52 }),
  cluster({ clusterId: "c-move", label: "move the task to done", support: 26 }),
  cluster({ clusterId: "c-docs", label: "where is order 0?", support: 12 }),
];
const EDGES = [
  edge({ clusterId: "c-create", capabilityId: "acme_create_task", weight: 62 }),
  edge({ clusterId: "c-create", capabilityId: "linear_create_issue", weight: 8 }),
  edge({ clusterId: "c-status", capabilityId: "acme_update_task", weight: 52 }),
  edge({ clusterId: "c-move", capabilityId: "acme_update_task", weight: 17 }),
  edge({ clusterId: "c-move", capabilityId: "acme_complete_task_with_review", weight: 9 }),
  edge({ clusterId: "c-docs", capabilityId: "search_docs", weight: 12 }),
  edge({ clusterId: "c-docs", kind: "skill", capabilityId: "explain-error", weight: 0 }),
];

test("the model holds groups, the capabilities that answered them, and each link's share", () => {
  const model = buildIntentMapModel({ clusters: CLUSTERS, edges: EDGES });
  assert.deepEqual(
    model.asks.map((ask) => [ask.id, ask.label, ask.volume]),
    [
      ["c-create", "Create a task", 70],
      ["c-status", "Update a task's status", 52],
      ["c-move", "Move the task to done", 26],
      ["c-docs", "Where is order 0", 12],
    ],
  );
  const update = model.capabilities.find((capability) => capability.id === "tool:acme_update_task");
  assert.deepEqual(update, {
    id: "tool:acme_update_task",
    kind: "tool",
    name: "acme_update_task",
    calls: 69,
    asks: 2,
    missing: false,
  });
  const moveLinks = model.links.filter((link) => link.ask === "c-move");
  assert.deepEqual(
    moveLinks.map((link) => [link.capability, Math.round(link.share * 100)]),
    [
      ["tool:acme_update_task", 65],
      ["tool:acme_complete_task_with_review", 35],
    ],
  );
  assert.ok(
    !model.capabilities.some((capability) => capability.kind === "skill"),
    "an edge with no calls draws nothing",
  );
  assert.equal(model.hidden, null);
  assert.deepEqual(
    model.capabilities.map((capability) => capability.id).slice(0, 2),
    ["tool:acme_update_task", "tool:acme_create_task"],
    "busiest capability first",
  );
});

test("the layout key follows ids, volumes and links only, so a refresh or a relabel keeps the drawing", () => {
  const first = buildIntentMapModel({ clusters: CLUSTERS, edges: EDGES });
  const again = buildIntentMapModel({
    clusters: CLUSTERS.map((row) => ({ ...row })),
    edges: EDGES.map((row) => ({ ...row })),
  });
  assert.notEqual(first, again);
  assert.equal(mapLayoutKey(first), mapLayoutKey(again), "a new copy of the same model");
  const relabelled = buildIntentMapModel({
    clusters: CLUSTERS.map((row) =>
      row.clusterId === "c-move" ? { ...row, labelOverride: "close a task" } : row,
    ),
    edges: EDGES,
    missing: new Set(["tool:search_docs"]),
    outcomes: [{ clusterId: "c-move", ranked: 26, firstTry: 2, shaped: 0 }],
  });
  assert.equal(
    mapLayoutKey(first),
    mapLayoutKey(relabelled),
    "a new label or problem moves nothing",
  );
  const busier = buildIntentMapModel({
    clusters: CLUSTERS,
    edges: EDGES.map((row) => (row.capabilityId === "search_docs" ? { ...row, weight: 13 } : row)),
  });
  assert.notEqual(mapLayoutKey(first), mapLayoutKey(busier), "a link's weight does");
  const grown = buildIntentMapModel({
    clusters: CLUSTERS.map((row) => (row.clusterId === "c-docs" ? { ...row, support: 40 } : row)),
    edges: EDGES,
  });
  assert.notEqual(mapLayoutKey(first), mapLayoutKey(grown), "and so does a group's volume");
});

test("groups are named by id in attributes, never by their label", () => {
  const model = buildIntentMapModel({
    clusters: CLUSTERS,
    edges: EDGES,
    missing: new Set(["tool:search_docs"]),
  });
  const docs = model.asks.find((ask) => ask.id === "c-docs")!;
  const name = askGroupName(docs, 2);
  assert.equal(name, "Intent c-docs: 12 asks, 2 tools, needs a look");
  assert.ok(!name.includes(docs.label));
  assert.equal(
    askGroupName({ id: "c-x", volume: 1, problem: null }, 1),
    "Intent c-x: 1 ask, 1 tool",
  );
  assert.equal(
    askGroupName({ id: "t_pay", volume: 9, problem: { kind: "unanswered", rate: 0.7 } }, 3),
    "Intent t_pay: 9 asks, 3 tools, mostly unanswered",
  );
});

test("an intent that mostly went unanswered says so in a sentence and a word", () => {
  assert.equal(
    problemSentence({ kind: "unanswered", rate: 0.62 }),
    "62% of its turns went unanswered.",
  );
  assert.equal(problemWord({ kind: "unanswered", rate: 0.62 }), "Mostly unanswered");
  assert.equal(problemWord({ kind: "first-try", rate: 0.2 }), "Needs a look");
});

test("the rule and each group's reading are said in words", () => {
  const reading = { searches: 598, capped: false, windowDays: 30 };
  assert.equal(
    problemRule(reading),
    "A group needs a look when its main tool left your catalog, or when, over 10 or more of its searches in the last 30 days, the first result was the tool the agent ran under 50% of the time. Searches whose list a Cloud graph ranked are not counted.",
  );
  assert.match(
    problemRule({ searches: 2000, capped: true, windowDays: 30 }),
    /the latest 2,000 searches of the last 30 days/,
  );
  assert.equal(
    firstTrySentence({ firstTry: { rate: 0.19, searches: 36 }, rankedByGraph: 4 }, reading),
    "Of its 36 searches in the last 30 days that showed a list and then ran a tool, the first result was that tool 19% of the time. 4 more were ranked by a Cloud graph and are not counted.",
  );
  assert.equal(
    firstTrySentence({ firstTry: null, rankedByGraph: 0 }, reading),
    "Not measured: none of its searches in the last 30 days showed a list and then ran a tool.",
  );
});

test("the map keeps the busiest groups and counts the rest", () => {
  const model = buildIntentMapModel({ clusters: CLUSTERS, edges: EDGES, maxAsks: 2 });
  assert.deepEqual(
    model.asks.map((ask) => ask.id),
    ["c-create", "c-status"],
  );
  assert.deepEqual(model.hidden, { asks: 2, volume: 38 });
  assert.ok(model.links.every((link) => link.ask === "c-create" || link.ask === "c-status"));
  assert.ok(!model.capabilities.some((capability) => capability.name === "search_docs"));
});

test("a group is a problem when its main tool left the catalog or its first result is usually wrong", () => {
  const model = buildIntentMapModel({
    clusters: CLUSTERS,
    edges: EDGES,
    missing: new Set([capabilityKey("tool", "search_docs")]),
    outcomes: [
      { clusterId: "c-move", ranked: 26, firstTry: 9, shaped: 0 },
      { clusterId: "c-status", ranked: 52, firstTry: 52, shaped: 3 },
      { clusterId: "c-create", ranked: 6, firstTry: 1, shaped: 0 },
    ],
  });
  const byId = new Map(model.asks.map((ask) => [ask.id, ask]));
  assert.deepEqual(byId.get("c-docs")?.problem, { kind: "missing", capability: "search_docs" });
  assert.equal(byId.get("c-move")?.problem?.kind, "first-try");
  assert.equal(byId.get("c-status")?.problem, null);
  assert.equal(byId.get("c-create")?.problem, null, "six searches are too few to judge");
  assert.deepEqual(byId.get("c-create")?.firstTry, { rate: 1 / 6, searches: 6 });
  assert.equal(byId.get("c-docs")?.firstTry, null, "nothing measured, nothing claimed");
  assert.match(
    problemSentence(byId.get("c-docs")!.problem!),
    /search_docs, is no longer in your catalog/,
  );
  assert.match(problemSentence(byId.get("c-move")!.problem!), /only 35% of the time/);
  assert.equal(
    model.capabilities.find((capability) => capability.name === "search_docs")?.missing,
    true,
  );
});

test("asks table rows carry share, answers in order, and sort three ways", () => {
  const model = buildIntentMapModel({
    clusters: CLUSTERS,
    edges: EDGES,
    outcomes: [
      { clusterId: "c-move", ranked: 26, firstTry: 9, shaped: 0 },
      { clusterId: "c-status", ranked: 52, firstTry: 52, shaped: 3 },
    ],
  });
  const rows = buildAskRows(model);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["c-create", "c-status", "c-move", "c-docs"],
  );
  assert.equal(Math.round(rows[0]!.share * 1000), 438, "70 of 160 asks");
  assert.deepEqual(
    rows[2]!.answers.map((answer) => answer.name),
    ["acme_update_task", "acme_complete_task_with_review"],
  );
  assert.deepEqual(
    buildAskRows(model, "first-try")
      .map((row) => row.id)
      .slice(0, 2),
    ["c-move", "c-status"],
    "worst measured first",
  );
  assert.deepEqual(buildAskRows(model, "label").map((row) => row.id)[0], "c-create");
  assert.equal(parseAskSort("first-try"), "first-try");
  assert.equal(parseAskSort("anything"), "volume");
});

test("a capability's groups, busiest first", () => {
  const model = buildIntentMapModel({ clusters: CLUSTERS, edges: EDGES });
  assert.deepEqual(
    capabilityAsks(model, "tool:acme_update_task").map((entry) => [entry.ask.id, entry.weight]),
    [
      ["c-status", 52],
      ["c-move", 17],
    ],
  );
  assert.deepEqual(splitCapabilityKey("tool:ripgrep"), { kind: "tool", id: "ripgrep" });
  assert.deepEqual(splitCapabilityKey("skill:review:pr"), { kind: "skill", id: "review:pr" });
  assert.equal(splitCapabilityKey("other:x"), null);
  assert.equal(splitCapabilityKey("ripgrep"), null);
});

test("header figures and compact numbers", () => {
  assert.deepEqual(intentFigures(CLUSTERS, EDGES), {
    askGroups: 4,
    asksSeen: 160,
    tools: 5,
    skills: 0,
  });
  assert.equal(compactNumber(640), "640");
  assert.equal(compactNumber(12_400), "12.4K");
  assert.equal(compactNumber(Number.NaN), "0");
});
