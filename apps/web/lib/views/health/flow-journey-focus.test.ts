import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prerequisiteCaption,
  prerequisiteView,
} from "@/components/console/health/journey-prerequisites";
import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, FlowJourneyPath } from "@/lib/readings/trace-signals/view";
import {
  journeyChainFocus,
  journeyPairFocus,
  journeyPrerequisiteFocus,
} from "@/lib/views/health/flow-journey-focus";
import { type JourneyLayout, layoutJourney } from "@/lib/views/health/flow-journey-layout";

function path(start: FlowJourneyPath["start"], tools: string[], turns: number): FlowJourneyPath {
  return { start, tools, end: "ended", turns };
}

function journey(paths: FlowJourneyPath[]): FlowJourney {
  const ids = [...new Set(paths.flatMap((p) => p.tools))].sort();
  return {
    steps: 3,
    turns: paths.reduce((sum, p) => sum + p.turns, 0),
    paths,
    tools: ids.map((id) => ({
      id,
      kind: "tool" as const,
      label: id,
      tint: "none" as const,
      signalIds: [],
      flags: [],
    })),
    otherTools: [0, 0, 0],
    searchSignalIds: [],
  };
}

function rel(first: string, tool: string, confidence: number, turns: number): JourneyPrerequisite {
  return {
    first,
    tool,
    firstLabel: first,
    toolLabel: tool,
    turns,
    together: Math.round(confidence * turns),
    confidence,
    lift: 5,
    tier: confidence >= 0.8 ? "strong" : "usual",
  };
}

/** The demo in miniature: find before assign (sometimes via members), search before details, and turns needing nothing. */
const DEMO = journey([
  path("search", ["find", "assign"], 84),
  path("search", ["find", "members", "assign"], 14),
  path("search", ["find"], 60),
  path("search", ["search", "details"], 48),
  path("none", ["details"], 22),
  path("none", ["create"], 300),
]);
const RELATIONS = [rel("find", "assign", 1, 98), rel("search", "details", 0.69, 70)];

function layout(): JourneyLayout {
  return layoutJourney(DEMO, { showAll: true })!;
}

test("a pair lights both tools and the calls between them, in every turn that ran them in order", () => {
  const focus = journeyPairFocus(layout(), "find", "assign");
  assert.equal(focus.turns, 98);
  assert.equal(focus.nodes.get("c1:find"), 98);
  assert.equal(focus.nodes.get("c2:assign"), 84);
  assert.equal(focus.nodes.get("c2:members"), 14, "the step between");
  assert.equal(focus.nodes.get("c3:assign"), 14);
  assert.equal(focus.nodes.get("s:search"), undefined, "what came before the pair stays out");
  assert.equal(journeyPairFocus(layout(), "assign", "find").turns, 0, "order matters");
});

test("the prerequisites view is every pair's turns at once, each turn counted once per link", () => {
  const l = layout();
  const { focus, needs, firsts } = journeyPrerequisiteFocus(l, RELATIONS);
  assert.equal(focus.turns, 98 + 48);
  assert.deepEqual([...needs.keys()].sort(), ["c2:assign", "c2:details", "c3:assign"]);
  assert.deepEqual([...firsts.keys()].sort(), ["c1:find", "c1:search"]);
  for (const [key, lit] of focus.ribbons) {
    const ribbon = l.ribbons.find((r) => r.key === key);
    assert.ok(ribbon && lit <= ribbon.turns, `${key} lights at most its own turns`);
  }
  // Two relations over the same turns never double a link.
  const twice = journeyPrerequisiteFocus(l, [
    rel("find", "assign", 1, 98),
    rel("find", "members", 1, 14),
  ]).focus;
  for (const [key, lit] of twice.ribbons) {
    assert.ok(lit <= l.ribbons.find((r) => r.key === key)!.turns, key);
  }
  assert.equal(twice.nodes.get("c1:find"), 98);
});

test("a chain lights only its calls back to back", () => {
  const focus = journeyChainFocus(layout(), ["find", "members", "assign"]);
  assert.equal(focus.turns, 14);
  assert.deepEqual([...focus.nodes.keys()].sort(), ["c1:find", "c2:members", "c3:assign"]);
  assert.equal(
    journeyChainFocus(layout(), ["find", "assign"]).turns,
    84,
    "not the turns with a step between",
  );
});

test("filtered, only each pair's ends and the steps between them stay; the rest is left out", () => {
  const l = layout();
  const view = prerequisiteView(l, RELATIONS, journeyPrerequisiteFocus(l, RELATIONS), null);
  const kept = l.nodes
    .filter((n) => !view.hidden.has(n.key))
    .map((n) => n.key)
    .sort();
  assert.deepEqual(kept, [
    "c1:find",
    "c1:search",
    "c2:assign",
    "c2:details",
    "c2:members",
    "c3:assign",
  ]);
  assert.deepEqual([...view.via], ["c2:members"]);
  assert.ok(
    view.hidden.has("s:search") && view.hidden.has("c1:create") && view.hidden.has("e2"),
    "start, others and Ended hide",
  );
  assert.equal(view.captions.get("c2:assign"), "100% after find");
  assert.equal(view.captions.get("c2:details"), "69% after search");
  assert.equal(view.captions.get("c1:find"), undefined, "the first tool keeps its count");
  assert.equal(view.sentences, null);
  assert.ok(view.strong, "a usual pair is drawn lighter under the strong one");
  assert.equal(view.strong?.nodes.get("c2:details"), undefined);
  assert.equal(view.pointed, false);
});

test("pointing at a kept chip reads its sentences and lights its own pairs; a step between says so", () => {
  const l = layout();
  const all = journeyPrerequisiteFocus(l, RELATIONS);
  const assign = prerequisiteView(l, RELATIONS, all, "c3:assign");
  assert.deepEqual(assign.sentences, ["assign: find ran first in 100% of its 98 turns"]);
  assert.equal(assign.focus.node, "c3:assign");
  assert.equal(assign.focus.nodes.get("c1:search"), undefined, "the other pair dims");
  const via = prerequisiteView(l, RELATIONS, all, "c2:members");
  assert.deepEqual(via.sentences, ["members ran in between, in 14 of these turns."]);
  const hidden = prerequisiteView(l, RELATIONS, all, "c1:create");
  assert.equal(hidden.sentences, null, "a hidden chip cannot be pointed at");
});

test("a caption fits its chip, and names how many more tools are needed first", () => {
  const caption = prerequisiteCaption({ w: 176, flags: [] }, [
    rel("find_task", "assign_task", 0.95, 95),
    rel("list_members", "assign_task", 0.9, 95),
  ]);
  assert.equal(caption, "95% after find_task +1");
  const long = prerequisiteCaption({ w: 176, flags: ["errors"] }, [
    rel("a_really_long_lookup_tool_name", "b", 1, 50),
  ]);
  assert.ok(long.endsWith("…") && long.startsWith("100% after "), long);
  assert.ok(long.length * 10.5 * 0.6 <= 176 - 26 - 10 - 15, long);
  assert.equal(
    prerequisiteCaption({ w: 100, flags: ["errors"] }, [rel("lookup", "b", 1, 50)]),
    "100%",
    "too narrow to name it",
  );
});
