import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowJourney, FlowJourneyPath } from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";
import {
  boxesOverlap,
  chipCard,
  JOURNEY_CHIP,
  JOURNEY_CHIP_PADDING,
  JOURNEY_ENDED_FAMILY,
  JOURNEY_EXPAND_STEP,
  JOURNEY_FAMILIES,
  JOURNEY_FONT,
  JOURNEY_LINK_MIN_TURNS,
  JOURNEY_MAX_CALLS,
  JOURNEY_SHOWN_TOOLS,
  JOURNEY_VISIBLE_CALLS,
  type JourneyLayout,
  type JourneyRibbon,
  journeyFocus,
  journeyTextBoxes,
  layoutJourney,
  ribbonBox,
  ribbonCentreAt,
  toolIdOf,
} from "@/lib/views/health/flow-journey-layout";
import { syntheticJourneyFlow } from "@/lib/views/health/flow-synthetic";

function path(
  start: FlowJourneyPath["start"],
  tools: string[],
  turns: number,
  end: FlowJourneyPath["end"] = "ended",
): FlowJourneyPath {
  return { start, tools, end, turns };
}

function journey(paths: FlowJourneyPath[], otherTools: number[] = [0, 0, 0]): FlowJourney {
  const ids = [...new Set(paths.flatMap((p) => p.tools))].sort();
  return {
    steps: 3,
    turns: paths.reduce((sum, p) => sum + p.turns, 0),
    paths,
    tools: ids.map((id) => ({
      id,
      kind: id === FLOW_JOURNEY_OTHER ? "other" : "tool",
      label: id === FLOW_JOURNEY_OTHER ? "Other tools" : id,
      tint: id === "sync" ? "healthy" : "none",
      signalIds: [],
      flags: id === "update" ? ["errors"] : [],
    })),
    otherTools,
    searchSignalIds: [],
  };
}

/** Acme's shape in miniature: blind first calls, a repeat, dead ends, and a long tail. */
const SAMPLE = journey(
  [
    path("none", ["sync"], 40),
    path("none", ["comment"], 30),
    path("none", ["update", "update"], 12),
    path("none", ["update", "comment", "create"], 6),
    path("none", ["update", "comment", "create"], 5, "more"),
    path("search", ["create", "update"], 9),
    path("search", [], 4),
    path("none", ["sync", "comment"], 7),
    path("none", ["lookup"], 3),
    path("none", ["find"], 2),
    path("none", [FLOW_JOURNEY_OTHER, "update"], 3),
  ],
  [4, 0, 0],
);

function layout(): JourneyLayout {
  return layoutJourney(SAMPLE)!;
}

function node(l: JourneyLayout, key: string) {
  const found = l.nodes.find((n) => n.key === key);
  assert.ok(found, `node ${key}`);
  return found;
}

test("columns are positions in a turn: start, 1st, 2nd and 3rd call, then", () => {
  const l = layout();
  assert.deepEqual(
    l.columns.map((c) => c.title),
    ["Start", "1st call", "2nd call", "3rd call", "Then"],
  );
  assert.deepEqual(
    l.columns.map((c) => c.turns),
    [SAMPLE.turns, SAMPLE.turns - 4, 42, 11, 5],
    "each column counts the turns that made that call",
  );
  assert.equal(node(l, "s:search").label, "Searched first");
  assert.equal(node(l, "s:none").label, "No search");
});

test("every ribbon leads somewhere: each turn ends in Ended or More calls", () => {
  const l = layout();
  for (const route of l.routes) {
    const last = route.keys[route.keys.length - 1];
    assert.ok(
      last === "more" || /^e\d$/.test(last),
      `${route.keys.join(" > ")} ends at a terminal`,
    );
  }
  assert.equal(node(l, "e1").turns, 4, "searched and then called nothing");
  assert.equal(node(l, "e2").turns, 40 + 30 + 3 + 2, "stopped after their 1st call");
  assert.equal(node(l, "more").turns, 5);
  for (const ended of l.nodes.filter((n) => n.kind === "ended")) {
    const column = l.nodes.filter((n) => n.column === ended.column);
    assert.equal(column.at(-1)?.key, ended.key, "Ended is the last node of its column");
  }
  assert.ok(
    l.ribbons.filter((r) => r.to.startsWith("e")).every((r) => r.family === JOURNEY_ENDED_FAMILY),
    "a ribbon into Ended is grey",
  );
});

test("turns are conserved: a node's ribbons in and out add up to its turns", () => {
  const l = layoutJourney(SAMPLE, { showAll: true })!;
  for (const n of l.nodes) {
    const into = l.ribbons.filter((r) => r.to === n.key).reduce((sum, r) => sum + r.turns, 0);
    const out = l.ribbons.filter((r) => r.from === n.key).reduce((sum, r) => sum + r.turns, 0);
    if (n.column > 0) assert.equal(into, n.turns, `into ${n.key}`);
    if (n.kind !== "ended" && n.kind !== "more") assert.equal(out, n.turns, `out of ${n.key}`);
  }
  assert.equal(node(l, "c1:update").ended, 0);
  assert.equal(node(l, "c2:update").ended, 12 + 9 + 3);
});

test("a repeat is a ribbon from a tool to itself one column over", () => {
  const l = layout();
  const repeat = l.ribbons.filter((r) => r.from === "c1:update" && r.to === "c2:update");
  assert.equal(
    repeat.reduce((sum, r) => sum + r.turns, 0),
    12,
  );
});

test("ribbons take the colour of the path's first tool, for the busiest first tools only", () => {
  const l = layout();
  assert.deepEqual(
    l.families.map((f) => f.id),
    ["sync", "comment", "update", "create", "lookup", "find"].slice(0, JOURNEY_FAMILIES),
  );
  const fromUpdate = l.ribbons.filter((r) => r.from === "c2:comment" && r.to === "c3:create");
  assert.deepEqual(
    new Set(fromUpdate.map((r) => r.family)),
    new Set([2]),
    "update's family all the way along",
  );
  assert.ok(
    l.ribbons.filter((r) => r.from === "c1:find").every((r) => r.family === JOURNEY_ENDED_FAMILY),
  );
  assert.ok(
    l.ribbons.filter((r) => r.to === "c1:~other").every((r) => r.family === -1),
    "folded first tools are grey",
  );
  assert.ok(l.families.length <= JOURNEY_FAMILIES);
});

test("pointing at a node lights exactly the turns through it, upstream and downstream", () => {
  const l = layoutJourney(SAMPLE, { showAll: true })!;
  const focus = journeyFocus(l, "c2:update");
  assert.equal(focus.turns, 12 + 9 + 3);
  assert.equal(focus.nodes.get("s:search"), 9);
  assert.equal(focus.nodes.get("s:none"), 15);
  assert.equal(focus.nodes.get("c1:update"), 12);
  assert.equal(focus.nodes.get("e3"), 24, "all of them stopped after it");
  assert.equal(focus.nodes.get("c2:comment"), undefined);
  for (const [key, lit] of focus.ribbons) {
    const ribbon = l.ribbons.find((r) => r.key === key);
    assert.ok(ribbon && lit <= ribbon.turns, `${key} lights at most its own turns`);
  }
});

test("the same journey lays out identically in any path order", () => {
  const reversed = {
    ...SAMPLE,
    paths: [...SAMPLE.paths].reverse(),
    tools: [...SAMPLE.tools].reverse(),
  };
  assert.deepEqual(layoutJourney(reversed), layout());
});

/** Asserts no text box (column title or chip) shares any area with any ribbon. */
function assertTextClearOfRibbons(l: JourneyLayout, name: string) {
  const texts = journeyTextBoxes(l);
  assert.ok(texts.length > l.nodes.length, "titles and chips are both checked");
  for (const ribbon of l.ribbons) {
    const box = ribbonBox(ribbon);
    for (const text of texts) {
      assert.ok(
        !boxesOverlap(box, text),
        `${name}: ribbon ${ribbon.key} crosses text at ${JSON.stringify(text)}`,
      );
    }
  }
}

test("no ribbon ever crosses text: ribbons run only in the gaps between lanes of chips", () => {
  assertTextClearOfRibbons(layout(), "acme-like");
  assertTextClearOfRibbons(layoutJourney(syntheticJourneyFlow(120).journey)!, "synthetic 120");
  for (const ribbon of layout().ribbons) {
    const from = node(layout(), ribbon.from);
    const to = node(layout(), ribbon.to);
    assert.equal(ribbon.x0, from.x + from.w, `${ribbon.key} leaves its chip's right edge`);
    assert.equal(ribbon.x1, to.x, `${ribbon.key} reaches the next chip's left edge`);
    assert.deepEqual([ribbon.stations[0].x, ribbon.stations.at(-1)!.x], [ribbon.x0, ribbon.x1]);
  }
});

test("lanes: chips of a column share their left edge and width, and never overlap", () => {
  for (const l of [layout(), layoutJourney(syntheticJourneyFlow(120).journey)!]) {
    const last = l.columns[l.columns.length - 1];
    assert.equal(l.width, last.x + last.width + 12, "the drawing ends just past its last column");
    for (const column of l.columns) {
      const list = l.nodes.filter((n) => n.column === column.index);
      for (const n of list) {
        assert.equal(n.x, column.x);
        assert.equal(n.w, column.width);
        assert.ok(n.x + n.w <= l.width && n.y + n.h <= l.height, `${n.key} is inside the frame`);
      }
      for (let i = 1; i < list.length; i += 1) {
        assert.ok(
          list[i].y >= list[i - 1].y + list[i - 1].h + 8,
          `${list[i].key} clears ${list[i - 1].key}`,
        );
      }
    }
    const gaps = l.columns.slice(1).map((c, i) => c.x - (l.columns[i].x + l.columns[i].width));
    assert.ok(gaps[0] >= 110, `the first gap, where the start fans out, is wide (${gaps[0]}px)`);
    for (const gap of gaps.slice(1))
      assert.ok(gap >= 55 && gap < gaps[0], `a ${gap}px gap for the ribbons`);
  }
});

/**
 * The demo in miniature: nearly every turn searched first, seven named first
 * calls, a heavy "+N tools" chip and a heavy "Ended" at the bottom of the
 * column, and a thin "No search" start. The shape behind the twists and dives.
 */
const DEMO_LIKE = (() => {
  const named = [
    ["find_task", 175],
    ["search_tasks", 151],
    ["filter_tasks", 92],
    ["entity_lookup", 87],
    ["get_document_content", 65],
    ["add_task_comment", 54],
    ["link_pr_to_task", 53],
  ] as const;
  const quiet = Array.from(
    { length: 12 },
    (_, i) => [`quiet_tool_${String(i).padStart(2, "0")}`, 30 + i] as const,
  );
  const paths = [
    ...named.flatMap(([id, n]) => [
      path("search", [id], Math.round(n * 0.6)),
      path("search", [id, "assign_task"], n - Math.round(n * 0.6)),
    ]),
    ...quiet.map(([id, n]) => path("search", [id], n)),
    path("search", [], 208),
    path("none", ["quiet_tool_00"], 27),
  ];
  return journey(paths, [0, 0, 0]);
})();

/** The acme-like and demo-like fixtures and the synthetic 120-tool catalog. */
function cases(): [string, JourneyLayout][] {
  return [
    ["acme-like", layout()],
    ["demo-like", layoutJourney(DEMO_LIKE)!],
    ["synthetic 120", layoutJourney(syntheticJourneyFlow(120).journey)!],
  ];
}

/** Pairs of ribbons of one chip (same source, or same target) whose centrelines swap order along the gap. */
function bundleCrossings(l: JourneyLayout): string[] {
  const found: string[] = [];
  for (const end of ["from", "to"] as const) {
    const groups = new Map<string, JourneyRibbon[]>();
    for (const ribbon of l.ribbons)
      groups.set(ribbon[end], [...(groups.get(ribbon[end]) ?? []), ribbon]);
    for (const list of groups.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const [a, b] = [list[i], list[j]];
          const xs = Array.from({ length: 81 }, (_, k) => a.x0 + ((a.x1 - a.x0) * k) / 80);
          const signs = new Set(
            xs
              .map((x) => Math.sign(ribbonCentreAt(a, x) - ribbonCentreAt(b, x)))
              .filter((v) => v !== 0),
          );
          if (signs.size > 1) found.push(`${a.key} x ${b.key}`);
        }
      }
    }
  }
  return found;
}

/** The steepest angle, in degrees, of a ribbon's centreline over the given share of its gap. */
function steepest(ribbon: JourneyRibbon, from: number, to: number): number {
  const width = ribbon.x1 - ribbon.x0;
  let worst = 0;
  for (let k = 0; k < 40; k += 1) {
    const xa = ribbon.x0 + width * (from + ((to - from) * k) / 40);
    const xb = ribbon.x0 + width * (from + ((to - from) * (k + 1)) / 40);
    const rise = Math.abs(ribbonCentreAt(ribbon, xb) - ribbonCentreAt(ribbon, xa));
    worst = Math.max(worst, (Math.atan2(rise, xb - xa) * 180) / Math.PI);
  }
  return worst;
}

test("all chips share one height: no chip grows", () => {
  for (const [, l] of cases()) {
    assert.deepEqual([...new Set(l.nodes.map((n) => n.h))], [JOURNEY_CHIP.height]);
  }
});

test("every ribbon attaches flush to its chip's edge, inside the chip's bounds, at least about 1px", () => {
  for (const [name, l] of cases()) {
    for (const ribbon of l.ribbons) {
      const from = node(l, ribbon.from);
      const to = node(l, ribbon.to);
      assert.equal(ribbon.x0, from.x + from.w, `${name}: ${ribbon.key} is flush with its source`);
      assert.equal(ribbon.x1, to.x, `${name}: ${ribbon.key} is flush with its target`);
      const inside = (y: number, t: number, chip: typeof from) =>
        y >= chip.y - 0.05 && y + t <= chip.y + chip.h + 0.05;
      assert.ok(
        inside(ribbon.y0, ribbon.t0, from),
        `${name}: ${ribbon.key} attaches inside ${from.key}`,
      );
      assert.ok(
        inside(ribbon.y1, ribbon.t1, to),
        `${name}: ${ribbon.key} attaches inside ${to.key}`,
      );
      assert.ok(
        ribbon.t0 >= 0.9 && ribbon.t1 >= 0.9,
        `${name}: ${ribbon.key} is at least about 1px where it attaches`,
      );
    }
  }
});

test("no two ribbons of one chip ever cross, anywhere along the gap", () => {
  for (const [name, l] of cases()) {
    assert.deepEqual(bundleCrossings(l), [], `${name} has no crossings inside a bundle`);
  }
});

test("nothing dives at the edges: every ribbon runs level out of and into its chips", () => {
  for (const [name, l] of cases()) {
    for (const ribbon of l.ribbons) {
      const edge = Math.max(steepest(ribbon, 0, 0.2), steepest(ribbon, 0.8, 1));
      assert.ok(
        edge < 15,
        `${name}: ${ribbon.key} is ${edge.toFixed(1)} degrees steep near a chip`,
      );
      const [out, level, turn, into] = ribbon.stations;
      assert.ok(
        level.x - out.x >= JOURNEY_CHIP.flatRun - 0.05 &&
          into.x - turn.x >= JOURNEY_CHIP.flatRun - 0.05,
        `${ribbon.key} has level runs`,
      );
      assert.equal(level.y, out.y, `${ribbon.key} leaves level`);
      assert.equal(turn.y, into.y, `${ribbon.key} arrives level`);
    }
  }
});

test("a crowded start chip's ribbons leave compressed and only widen, in one smooth swing", () => {
  const l = layout();
  const start = node(l, "s:none");
  const ribbons = l.ribbons.filter((r) => r.from === start.key);
  const top = Math.min(...ribbons.map((r) => r.y0));
  const bottom = Math.max(...ribbons.map((r) => r.y0 + r.t0));
  assert.ok(
    bottom - top <= JOURNEY_CHIP.height - 2 * JOURNEY_CHIP.bandInset + 0.5,
    "the bundle fits the chip at its edge",
  );
  assert.ok(
    ribbons.some((r) => r.t1 > r.t0 + 1),
    "and some of it widens toward the next column",
  );
  for (const ribbon of ribbons) {
    assert.ok(ribbon.t1 >= ribbon.t0, `${ribbon.key} only widens`);
    assert.equal(
      ribbon.stations.length,
      4,
      `${ribbon.key} has one swing, no extra bend where it widens`,
    );
  }
});

test("a crowded Ended chip's inflow is fitted to the chip along the whole ribbon, no flare at the edge", () => {
  const l = layout();
  const ended = node(l, "e2");
  const ribbons = l.ribbons.filter((r) => r.to === ended.key);
  const total = ribbons.reduce((sum, r) => sum + r.t1, 0);
  assert.ok(
    total <= JOURNEY_CHIP.height - 2 * JOURNEY_CHIP.bandInset + 0.5,
    `${total}px fits the chip`,
  );
  for (const ribbon of ribbons)
    assert.equal(ribbon.t0, ribbon.t1, `${ribbon.key} keeps one thickness`);
});

test("start and Then chips sit near the centre of what they reach, in order, never overlapping", () => {
  for (const [name, l] of cases()) {
    for (const column of [l.columns[0], l.columns[l.columns.length - 1]]) {
      const chips = l.nodes.filter((n) => n.column === column.index);
      for (let i = 1; i < chips.length; i += 1) {
        assert.ok(
          chips[i].y >= chips[i - 1].y + chips[i - 1].h + 8,
          `${name}: ${chips[i].key} clears ${chips[i - 1].key}`,
        );
      }
    }
    // The busiest start chip sits within its targets' span, not at the top of the lane.
    const start = l.nodes.filter((n) => n.column === 0).sort((a, b) => b.turns - a.turns)[0];
    const targets = l.ribbons.filter((r) => r.from === start.key).map((r) => node(l, r.to));
    const lowest = Math.min(...targets.map((n) => n.y));
    const highest = Math.max(...targets.map((n) => n.y));
    assert.ok(start.y > lowest && start.y < highest, `${name}: ${start.key} is centred on its fan`);
  }
});

test("a 120-tool catalog stays one screen tall: seven tools named a column, the rest one +N chip", () => {
  const l = layoutJourney(syntheticJourneyFlow(120).journey)!;
  for (const column of l.columns.filter((c) => c.role === "call")) {
    const chips = l.nodes.filter((n) => n.column === column.index);
    assert.ok(chips.filter((n) => n.kind === "tool").length <= JOURNEY_SHOWN_TOOLS, column.title);
    assert.equal(chips.filter((n) => n.kind === "other").length, 1);
  }
  assert.ok(l.height < 480, `${l.height} tall`);
  const other = l.nodes.find((n) => n.kind === "other" && n.column === 1)!;
  assert.match(other.label, /^\+\d+ tools$/);
  assert.ok((other.otherCount ?? 0) > 50);
});

test("names fit their chip, cut with an ellipsis when they do not", () => {
  const long = journey([path("none", ["a_really_long_tool_name_that_never_fits_anywhere"], 5)]);
  const chip = layoutJourney(long)!.nodes.find((n) => n.call === 1)!;
  assert.ok(chip.text.endsWith("…"));
  assert.ok(
    JOURNEY_CHIP.textX + chip.text.length * JOURNEY_FONT * 0.6 <= chip.w - JOURNEY_CHIP.padR,
  );
});

test("thin links hide by default: under 3 turns or 5% of what leaves their chip", () => {
  const plain = layout();
  const all = layoutJourney(SAMPLE, { showAll: true })!;
  const hidden = all.ribbons.filter((r) => !plain.ribbons.some((p) => p.key === r.key));
  assert.deepEqual(
    hidden.map((r) => `${r.from}>${r.to}`).sort(),
    ["c1:find>e2", "s:none>c1:find", "s:none>c1:lookup", "s:none>c1:~other"],
    "2, 3 and 3 turns out of the 108 that left No search, and find's 2 turns on to Ended",
  );
  assert.equal(plain.hiddenLinks, 4);
  assert.equal(all.hiddenLinks, 0);
  assert.ok(
    plain.ribbons.every((r) => r.turns >= JOURNEY_LINK_MIN_TURNS),
    "every drawn link carries enough turns",
  );
  assert.deepEqual(
    plain.nodes.map((n) => [n.key, n.turns, n.y]),
    all.nodes.map((n) => [n.key, n.turns, n.y]),
    "the chips, their totals and places do not move: only links hide",
  );
  assert.equal(node(plain, "c1:find").turns, 2, "a chip with no link drawn still shows its turns");
  assertTextClearOfRibbons(all, "show all");
});

test("a link at 5% of its chip's turns stays, one just under hides, and 2 turns always hides", () => {
  const into = (j: FlowJourney, id: string) =>
    layoutJourney(j)!.ribbons.some((r) => r.to === `c1:${id}`);
  assert.ok(
    into(journey([path("none", ["big"], 95), path("none", ["five"], 5)]), "five"),
    "5 of 100 is 5%",
  );
  assert.ok(
    !into(journey([path("none", ["big"], 96), path("none", ["five"], 5)]), "five"),
    "5 of 101 is under",
  );
  assert.ok(
    !into(journey([path("none", ["big"], 30), path("none", ["two"], 2)]), "two"),
    "2 turns, though 6%",
  );
  const share = journey([path("none", ["big"], 200), path("none", ["ten"], 10)]);
  assert.ok(!into(share, "ten"), "10 turns is under 5% of 210");
  assert.ok(
    layoutJourney(share, { showAll: true })!.ribbons.some((r) => r.to === "c1:ten"),
    "Show all links draws it",
  );
});

test("a chip key names its tool; start and terminal chips name none", () => {
  assert.equal(toolIdOf("c2:update_task"), "update_task");
  assert.equal(toolIdOf("s:none"), null);
  assert.equal(toolIdOf("e2"), null);
});

test("problem flags and tints reach the nodes; nothing to draw is null", () => {
  const l = layout();
  assert.deepEqual(node(l, "c1:update").flags, ["errors"]);
  assert.equal(node(l, "c1:sync").tint, "healthy");
  assert.equal(layoutJourney(undefined), null);
  assert.equal(layoutJourney(journey([])), null);
});

/* - Deeper steps and expanding "+N tools" ----------------------------------- */

/** A journey `steps` calls deep: a long tail of turns one to `steps + 2` calls long. */
function deepJourney(steps: number): FlowJourney {
  const tools = ["alpha", "beta", "gamma", "delta"];
  const paths = Array.from({ length: steps + 2 }, (_, length) => {
    const ids = Array.from(
      { length: Math.min(length + 1, steps) },
      (_, i) => tools[(length + i) % tools.length],
    );
    return path("none", ids, 40 - length * 3, length + 1 > steps ? "more" : "ended");
  });
  return {
    ...journey(
      paths,
      Array.from({ length: steps }, () => 0),
    ),
    steps,
  };
}

test("a deep journey draws every recorded call, up to the cap, then Then", () => {
  const l = layoutJourney(deepJourney(JOURNEY_MAX_CALLS), { depth: JOURNEY_MAX_CALLS })!;
  assert.equal(l.calls, JOURNEY_MAX_CALLS);
  assert.equal(l.depth, JOURNEY_MAX_CALLS);
  assert.deepEqual(
    l.columns.map((c) => c.title),
    [
      "Start",
      ...Array.from(
        { length: JOURNEY_MAX_CALLS },
        (_, i) => `${["1st", "2nd", "3rd"][i] ?? `${i + 1}th`} call`,
      ),
      "Then",
    ],
  );
  assert.ok(
    l.nodes.some((n) => n.kind === "more"),
    "longer turns still end in More calls",
  );
  assert.ok(l.width > 2000, "the drawing runs past the card, to scroll");
  assert.deepEqual(bundleCrossings(l), []);
});

test("a run stored with three calls still lays out to three, and fits the card", () => {
  const l = layout();
  assert.equal(l.calls, 3);
  assert.ok(l.width <= 1084, `${l.width}px fits a 1440 card without scrolling`);
});

/** Six first calls under the shown limit plus nine quiet ones, so "+N tools" can open three at a time. */
const WIDE = journey(
  [
    ...["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id, i) =>
      path("none", [id, "next"], 90 - i * 5),
    ),
    ...Array.from({ length: 9 }, (_, i) => path("none", [`quiet_${i}`, "next"], 20 - i)),
    path("search", [], 12),
  ],
  [0, 0, 0],
);

test("+N tools opens three more tools in place, and only its column moves", () => {
  const plain = layoutJourney(WIDE)!;
  const fold = plain.nodes.find((n) => n.kind === "other" && n.call === 1)!;
  assert.equal(fold.otherCount, 9);
  assert.equal(fold.expandable, 9);
  const open = layoutJourney(WIDE, { expanded: { 1: JOURNEY_EXPAND_STEP } })!;
  const named = (l: JourneyLayout) =>
    l.nodes.filter((n) => n.column === 1 && n.kind === "tool").map((n) => n.id);
  assert.deepEqual(
    named(open),
    [...named(plain), "quiet_0", "quiet_1", "quiet_2"],
    "the next three by turns",
  );
  const openFold = open.nodes.find((n) => n.kind === "other" && n.call === 1)!;
  assert.equal(openFold.otherCount, 6);
  assert.equal(openFold.expandable, 6);
  assert.equal(openFold.label, "+6 tools");
  for (const n of plain.nodes.filter((n) => n.column !== 1)) {
    assert.equal(node(open, n.key).y, n.y, `${n.key} stays where it was`);
  }
  for (const n of plain.nodes.filter((n) => n.column === 1 && n.kind === "tool")) {
    assert.equal(node(open, n.key).y, n.y, `${n.key}, above the new tools, stays put`);
  }
  assert.ok(open.height >= plain.height, "the column grows");
  assert.deepEqual(bundleCrossings(open), []);
  assertTextClearOfRibbons(open, "expanded");
});

test("opening every tool leaves no fold behind; folding back is the plain map", () => {
  const all = layoutJourney(WIDE, { expanded: { 1: 9 } })!;
  assert.equal(all.nodes.filter((n) => n.kind === "other" && n.call === 1).length, 0);
  assert.deepEqual(layoutJourney(WIDE, { expanded: {} }), layoutJourney(WIDE));
});

/* - Folded later calls, empty steps, chip padding ------------------------- */

/** A journey the run recorded eight positions for, but whose turns stop after `reached` calls. */
function reaching(reached: number): FlowJourney {
  return { ...deepJourney(reached), steps: JOURNEY_MAX_CALLS };
}

/** The widest map a 1440 card holds without scrolling. */
const CARD_WIDTH = 1084;

test("at rest the map fits its card: three calls, then one folded Later column for the rest", () => {
  const l = layoutJourney(deepJourney(JOURNEY_MAX_CALLS))!;
  assert.equal(l.depth, JOURNEY_VISIBLE_CALLS);
  assert.ok(l.width <= CARD_WIDTH, `${l.width}px fits the card`);
  for (const n of l.nodes)
    assert.ok(n.x + n.w <= l.width, `${n.key} is inside the drawing, not clipped`);
  const last = l.columns[l.columns.length - 1];
  assert.equal(last.role, "later");
  assert.equal(last.title, "Later");
  const later = l.nodes.find((n) => n.kind === "later")!;
  assert.equal(later.label, "4th to 8th", "the fold names the calls it holds");
  assert.equal(
    later.turns,
    l.routes.filter((r) => r.keys.includes("later")).reduce((sum, r) => sum + r.turns, 0),
  );
  assert.ok(
    l.nodes.some((n) => n.key === "e4" && n.column === last.index),
    "turns that ended after the 3rd call end in the fold's column",
  );
  assert.deepEqual(bundleCrossings(l), []);
  assertTextClearOfRibbons(l, "folded");
});

test("later calls unfold one column at a time, and the fold names what is left", () => {
  const four = layoutJourney(deepJourney(JOURNEY_MAX_CALLS), { depth: 4 })!;
  assert.deepEqual(
    four.columns.map((c) => c.title),
    ["Start", "1st call", "2nd call", "3rd call", "4th call", "Later"],
  );
  assert.equal(four.nodes.find((n) => n.kind === "later")?.label, "5th to 8th");
  const seven = layoutJourney(deepJourney(JOURNEY_MAX_CALLS), { depth: 7 })!;
  assert.equal(
    seven.nodes.find((n) => n.kind === "later")?.label,
    "8th call",
    "one call left is named on its own",
  );
  const all = layoutJourney(deepJourney(JOURNEY_MAX_CALLS), { depth: 99 })!;
  assert.equal(all.depth, JOURNEY_MAX_CALLS);
  assert.equal(all.columns[all.columns.length - 1].role, "then");
  assert.ok(!all.nodes.some((n) => n.kind === "later"));
  // Unfolding keeps the start chips where they were.
  const plain = layoutJourney(deepJourney(JOURNEY_MAX_CALLS))!;
  for (const n of plain.nodes.filter((n) => n.column === 0)) assert.equal(node(four, n.key).y, n.y);
});

test("a step no turn reached is not drawn at all, and the fold stops at the last real one", () => {
  const l = layoutJourney(reaching(6))!;
  assert.equal(l.calls, 6);
  assert.equal(l.nodes.find((n) => n.kind === "later")?.label, "4th to 6th");
  const open = layoutJourney(reaching(6), { depth: JOURNEY_MAX_CALLS })!;
  assert.equal(open.depth, 6);
  assert.deepEqual(
    open.columns.map((c) => c.title),
    ["Start", "1st call", "2nd call", "3rd call", "4th call", "5th call", "6th call", "Then"],
  );
  for (const layout of [l, open, layoutJourney(reaching(4))!]) {
    for (const column of layout.columns.slice(1)) {
      assert.ok(
        layout.nodes.some((n) => n.column === column.index),
        `${column.title} has chips`,
      );
    }
    for (const n of layout.nodes) assert.ok(n.turns > 0, `${n.key} has turns`);
  }
  assert.equal(
    layoutJourney(reaching(3))!.columns.at(-1)?.role,
    "then",
    "three calls or fewer need no fold",
  );
});

test("every chip keeps its content clear of its edges", () => {
  const layouts = [
    layout(),
    layoutJourney(deepJourney(JOURNEY_MAX_CALLS))!,
    layoutJourney(deepJourney(JOURNEY_MAX_CALLS), { depth: JOURNEY_MAX_CALLS })!,
    layoutJourney(syntheticJourneyFlow(120).journey)!,
    layoutJourney(WIDE)!,
  ];
  const kinds = new Set<string>();
  for (const l of layouts) {
    for (const n of l.nodes) {
      kinds.add(n.kind);
      const card = chipCard(n);
      const name = n.text.length * JOURNEY_FONT * 0.6;
      const count = String(n.turns.toLocaleString("en-US")).length * JOURNEY_FONT * 0.6;
      assert.ok(card.contentLeft - card.x >= JOURNEY_CHIP_PADDING, `${n.key}: room on the left`);
      assert.ok(
        card.x + card.w - card.contentRight >= JOURNEY_CHIP_PADDING,
        `${n.key}: room on the right`,
      );
      assert.ok(
        n.x + JOURNEY_CHIP.textX + Math.max(name, count) <= card.contentRight + 0.5,
        `${n.key}: "${n.text}" fits`,
      );
      assert.ok(
        card.h - 29 >= JOURNEY_CHIP_PADDING - 2,
        `${n.key}: the second line clears the bottom`,
      );
    }
  }
  for (const kind of ["tool", "other", "ended", "more", "later", "search", "none"]) {
    assert.ok(kinds.has(kind), `checked a ${kind} chip`);
  }
});
