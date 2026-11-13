import assert from "node:assert/strict";
import { test } from "node:test";
import { journeyNodeAriaLabel, journeyReadout } from "@/components/console/health/journey-copy";
import { prerequisiteView } from "@/components/console/health/journey-prerequisites";
import { splitRelations } from "@/components/console/health/use-prerequisite-filter";
import {
  FLOW_JOURNEY_OTHER,
  type FlowJourney,
  type FlowJourneyPath,
} from "@/lib/readings/trace-signals/view";
import { compactJourney } from "@/lib/views/health/flow-journey-compact";
import { journeyPrerequisiteFocus } from "@/lib/views/health/flow-journey-focus";
import { JOURNEY_MAX_CALLS, layoutJourney } from "@/lib/views/health/flow-journey-layout";
import {
  revealColumns,
  workflowFocusLayout,
  workflowRelations,
} from "@/lib/views/health/flow-journey-workflow";

function path(tools: string[], turns: number): FlowJourneyPath {
  return { start: "agent", tools, end: "ended", turns };
}

function journey(paths: FlowJourneyPath[]): FlowJourney {
  const ids = [...new Set(paths.flatMap((p) => p.tools))]
    .filter((id) => id !== FLOW_JOURNEY_OTHER)
    .sort();
  return {
    steps: 8,
    turns: paths.reduce((sum, p) => sum + p.turns, 0),
    paths,
    tools: ids.map((id) => ({
      id,
      kind: "tool" as const,
      label: `${id}!`,
      tint: "none" as const,
      signalIds: [],
      flags: [],
    })),
    otherTools: [],
    searchSignalIds: [],
  };
}

/** A release that mostly finishes, sometimes stops after its first step, and unrelated runs. */
const RELEASE = journey([
  path(["find_pr", "link_pr", "update_status", "notify"], 40),
  path(["find_pr", "link_pr", "update_status"], 12),
  path(["find_pr"], 8),
  path(["create_task", "assign_task"], 30),
]);

test("a workflow becomes its consecutive steps, counted off the map's own paths", () => {
  const steps = workflowRelations(RELEASE, ["find_pr", "link_pr", "update_status", "notify"]);
  assert.deepEqual(
    steps.map((s) => [s.first, s.tool, s.together, s.turns]),
    [
      ["find_pr", "link_pr", 52, 52],
      ["link_pr", "update_status", 52, 52],
      ["update_status", "notify", 40, 40],
    ],
  );
  assert.ok(steps.every((s) => s.tier === "strong" && s.confidence === 1 && !s.crossTurn));
  assert.equal(steps[0]!.firstLabel, "find_pr!", "labels come from the map's tools");
});

test("a step the map never shows after the one before it is left out, and too little means no focus", () => {
  const folded = journey([path(["a", FLOW_JOURNEY_OTHER, "c"], 20)]);
  assert.deepEqual(
    workflowRelations(folded, ["a", "b", "c"]).map((s) => `${s.first}>${s.tool}`),
    [],
  );
  assert.deepEqual(workflowRelations(RELEASE, ["notify", "find_pr"]), [], "never in that order");
  assert.deepEqual(workflowRelations(RELEASE, ["find_pr"]), [], "one step has no pair");
  assert.deepEqual(workflowRelations(undefined, ["a", "b"]), []);
});

test("the focus keeps only the workflow's runs on the same map: nothing from other runs shows", () => {
  const steps = workflowRelations(RELEASE, ["find_pr", "link_pr", "update_status", "notify"]);
  const deep = layoutJourney(RELEASE, { depth: JOURNEY_MAX_CALLS, showAll: true })!;
  const { along, across } = splitRelations(deep, steps);
  assert.equal(across.length, 0, "every step is drawn along the runs");
  const kept = journeyPrerequisiteFocus(deep, along);
  const view = prerequisiteView(deep, along, kept, null);
  assert.equal(kept.focus.turns, 52, "the runs that reached a second step");
  assert.ok(view.hidden.has("c1:create_task"), "an unrelated run is hidden");
  assert.ok(view.hidden.has("c2:assign_task"));
  assert.ok(!view.hidden.has("c4:notify"), "the last step stays");
});

test("an OpenTelemetry journey's start reads as the agent, never as a missed search", () => {
  const start = layoutJourney(RELEASE, { showAll: true })!.nodes.find((node) => node.column === 0)!;
  assert.equal(start.kind, "agent");
  assert.equal(start.label, "Agent");
  assert.equal(journeyNodeAriaLabel(start), "Agent started: 90 turns");
  assert.equal(
    journeyReadout(start, layoutJourney(RELEASE, { showAll: true })!, {
      node: start.key,
      turns: 0,
      nodes: new Map(),
      ribbons: new Map(),
    }).title,
    "Agent started",
  );
});

/** Eight busier tools open most runs, so the workflow's first step is not among a 1st call's named tools. */
const BUSY = journey([
  ...["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id, i) => path([id, "x"], 60 - i)),
  path(["find_pr", "link_pr", "update_status"], 12),
]);

test("a focused workflow starts in the 1st call column, even when that column folds its first step away", () => {
  const order = ["find_pr", "link_pr", "update_status"];
  const steps = workflowRelations(BUSY, order);
  assert.equal(steps.length, 2);
  const deep = workflowFocusLayout(BUSY, order)!;
  const { along, across } = splitRelations(deep, steps);
  assert.deepEqual(across, [], "no step falls to the rows under the map");
  const kept = journeyPrerequisiteFocus(deep, along);
  const packed = compactJourney(deep, kept.focus);
  const calls = packed.columns.filter((column) => column.call > 0);
  assert.equal(calls[0]?.call, 1, "the lane starts at the 1st call");
  const first = packed.nodes.find((node) => node.key === "c1:find_pr");
  assert.ok(first, "the first step has its own chip");
  assert.equal(packed.columns[first.column]?.call, 1);
});

test("the plain map still folds the busy column: only the workflow focus reveals its steps", () => {
  const plain = layoutJourney(BUSY, { depth: JOURNEY_MAX_CALLS, showAll: true })!;
  assert.ok(
    !plain.nodes.some((node) => node.key === "c1:find_pr"),
    "folded into other tools on the plain map",
  );
  const steps = workflowRelations(BUSY, ["find_pr", "link_pr", "update_status"]);
  assert.deepEqual(
    splitRelations(plain, steps).across.map((s) => `${s.first}>${s.tool}`),
    ["find_pr>link_pr"],
    "on the plain map the first step can only be drawn under it (the bug this focus layout fixes)",
  );
  assert.deepEqual(revealColumns(BUSY, ["find_pr"]), { 1: 2 }, "one column grows just enough");
  assert.deepEqual(revealColumns(BUSY, ["t1"]), {}, "a named tool needs nothing");
});
