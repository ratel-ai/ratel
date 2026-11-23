import assert from "node:assert/strict";
import { test } from "node:test";
import { canUnfoldMore, foldBackTo } from "@/components/console/health/use-journey-unfold";
import type { JourneyPrerequisite } from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, FlowJourneyPath } from "@/lib/readings/trace-signals/view";
import { compactJourney } from "./flow-journey-compact";
import { journeyPrerequisiteFocus } from "./flow-journey-focus";
import {
  boxesOverlap,
  JOURNEY_GRID,
  JOURNEY_MAX_CALLS,
  JOURNEY_VISIBLE_CALLS,
  type JourneyLayout,
  journeyTextBoxes,
  layoutJourney,
  ribbonBox,
} from "./flow-journey-layout";

function path(start: FlowJourneyPath["start"], tools: string[], turns: number): FlowJourneyPath {
  return { start, tools, end: "ended", turns };
}

function journey(paths: FlowJourneyPath[]): FlowJourney {
  const ids = [...new Set(paths.flatMap((p) => p.tools))].sort();
  return {
    steps: 8,
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
    otherTools: Array.from({ length: 8 }, () => 0),
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
    together: turns,
    confidence,
    lift: 5,
    tier: confidence >= 0.8 ? "strong" : "usual",
  };
}

/** The demo in miniature, with plenty in between that the filter drops. */
const DEMO = journey([
  path("search", ["find", "assign"], 84),
  path("search", ["find", "members", "assign"], 14),
  path("search", ["find"], 60),
  path("search", ["search", "details"], 48),
  path("search", ["lookup", "filter", "details"], 30),
  path("none", ["details"], 22),
  path("none", ["create", "comment", "update"], 300),
  path("none", ["sync"], 200),
]);
const DEMO_PAIRS = [rel("find", "assign", 1, 98), rel("search", "details", 0.69, 70)];

/** A pair deep in the turn: prepare ran 5th, publish 6th, after four calls the filter drops. */
const DEEP = journey([
  path("none", ["a", "b", "c", "d", "prepare", "publish"], 40),
  path("none", ["a", "b"], 200),
  path("none", ["c"], 100),
]);
const DEEP_PAIRS = [rel("prepare", "publish", 1, 40)];

function compacted(
  j: FlowJourney,
  pairs: JourneyPrerequisite[],
): { full: JourneyLayout; packed: JourneyLayout } {
  const full = layoutJourney(j, { depth: JOURNEY_MAX_CALLS, showAll: true })!;
  return { full, packed: compactJourney(full, journeyPrerequisiteFocus(full, pairs).focus) };
}

const CASES = { demo: compacted(DEMO, DEMO_PAIRS), deep: compacted(DEEP, DEEP_PAIRS) };

test("packed: only the kept chips, with the same keys, and no chip the filter drops", () => {
  const { full, packed } = CASES.demo;
  assert.deepEqual(packed.nodes.map((n) => n.key).sort(), [
    "c1:find",
    "c1:search",
    "c2:assign",
    "c2:details",
    "c2:members",
    "c3:assign",
  ]);
  const keys = new Set(full.nodes.map((n) => n.key));
  assert.ok(
    packed.nodes.every((n) => keys.has(n.key)),
    "every chip is one of the full map's, by key",
  );
  assert.ok(
    !packed.nodes.some(
      (n) =>
        ["s:search", "s:none", "c1:create", "c1:sync", "c2:filter"].includes(n.key) ||
        n.kind === "ended",
    ),
  );
});

test("packed: no empty column, the start and the end columns dropped, the rest side by side", () => {
  for (const [name, { packed }] of Object.entries(CASES)) {
    for (const column of packed.columns) {
      assert.ok(
        packed.nodes.some((n) => n.column === column.index),
        `${name}: ${column.title} holds a chip`,
      );
    }
    assert.ok(
      packed.columns.every((c) => c.role === "call"),
      `${name}: only call columns`,
    );
    assert.equal(
      packed.columns[0].x,
      JOURNEY_GRID.padX,
      `${name}: the first column starts at the edge`,
    );
    packed.columns.slice(1).forEach((column, i) => {
      const before = packed.columns[i];
      assert.equal(
        column.x,
        before.x + before.width + JOURNEY_GRID.gap,
        `${name}: ${column.title} follows on`,
      );
    });
    assert.equal(
      packed.width,
      packed.columns.at(-1)!.x + packed.columns.at(-1)!.width + JOURNEY_GRID.padX,
    );
  }
  assert.deepEqual(
    CASES.deep.packed.columns.map((c) => c.title),
    ["5th call", "6th call"],
    "a deep pair keeps its titles and draws with nothing folded before it",
  );
});

test("packed: each column stacks its chips from the top with normal spacing and no holes, in the full map's order", () => {
  for (const [name, { full, packed }] of Object.entries(CASES)) {
    for (const column of packed.columns) {
      const chips = packed.nodes.filter((n) => n.column === column.index).sort((a, b) => a.y - b.y);
      chips.forEach((chip, i) => {
        assert.equal(
          chip.y,
          JOURNEY_GRID.padTop + i * (JOURNEY_GRID.chipH + JOURNEY_GRID.chipGap),
          `${name} ${chip.key}`,
        );
        assert.equal(chip.x, column.x);
      });
      const order = chips.map((c) => full.nodes.find((n) => n.key === c.key)!.y);
      assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b),
        `${name}: same order as the full map`,
      );
    }
    const bottom = Math.max(...packed.nodes.map((n) => n.y + n.h));
    assert.equal(packed.height, bottom + JOURNEY_GRID.padBottom, `${name}: sized to what is left`);
    assert.ok(packed.height < full.height && packed.width < full.width);
  }
});

test("packed: nothing overlaps, and no link crosses a chip or a title", () => {
  for (const [name, { packed }] of Object.entries(CASES)) {
    for (let i = 0; i < packed.nodes.length; i += 1) {
      for (let j = i + 1; j < packed.nodes.length; j += 1) {
        assert.ok(
          !boxesOverlap(packed.nodes[i], packed.nodes[j]),
          `${name}: ${packed.nodes[i].key} and ${packed.nodes[j].key}`,
        );
      }
    }
    const texts = journeyTextBoxes(packed);
    for (const ribbon of packed.ribbons) {
      for (const text of texts)
        assert.ok(!boxesOverlap(ribbonBox(ribbon), text), `${name}: ${ribbon.key}`);
    }
  }
});

test("packed: the links are the kept turns only, each joining two kept chips in neighbouring columns", () => {
  const { full, packed } = CASES.demo;
  const focus = journeyPrerequisiteFocus(full, DEMO_PAIRS).focus;
  const byKey = new Map(packed.nodes.map((n) => [n.key, n]));
  assert.equal(packed.ribbons.length, focus.ribbons.size);
  for (const ribbon of packed.ribbons) {
    assert.equal(ribbon.turns, focus.ribbons.get(ribbon.key), ribbon.key);
    const from = byKey.get(ribbon.from);
    const to = byKey.get(ribbon.to);
    assert.ok(from && to, ribbon.key);
    assert.equal(to.column, from.column + 1);
    assert.equal(ribbon.x0, from.x + from.w);
    assert.equal(ribbon.x1, to.x);
  }
});

test("packed: complete and static, so scrolling never folds or unfolds it", () => {
  const { packed } = CASES.deep;
  assert.equal(packed.depth, packed.calls);
  assert.deepEqual(packed.expanded, {});
  assert.equal(canUnfoldMore(packed, false), false);
  for (const left of [0, 1, 200, 5000]) {
    assert.equal(foldBackTo(packed, { left, width: 342 }, false), null, `no fold at ${left}`);
  }
});

test("the whole map still folds and unfolds on scroll as before", () => {
  const folded = layoutJourney(DEEP, { showAll: true })!;
  assert.equal(folded.depth, JOURNEY_VISIBLE_CALLS);
  assert.equal(canUnfoldMore(folded, true), true);
  const unfolded = layoutJourney(DEEP, { showAll: true, depth: 5 })!;
  assert.deepEqual(foldBackTo(unfolded, { left: 0, width: 342 }, true), {
    depth: JOURNEY_VISIBLE_CALLS,
    after: 260,
  });
  const past = unfolded.columns[unfolded.depth].x;
  assert.deepEqual(foldBackTo(unfolded, { left: 10, width: past - 100 }, true), {
    depth: 4,
    after: 0,
  });
  assert.equal(foldBackTo(unfolded, { left: 10, width: 5000 }, true), null);
});

/* - Pairs the journey cannot draw: rows under it ------------------------------ */

function across(first: string, tool: string, uses: number, together: number): JourneyPrerequisite {
  return {
    ...rel(first, tool, together / uses, uses),
    together,
    scope: "window",
    windowMinutes: 10,
    crossTurn: true,
  };
}

const NONE = {
  node: "none",
  turns: 0,
  nodes: new Map<string, number>(),
  ribbons: new Map<string, number>(),
};

test("rows: each pair is its own row under the packed journey, in its first two columns, after a titled divider", () => {
  const { full } = CASES.demo;
  const focus = journeyPrerequisiteFocus(full, DEMO_PAIRS).focus;
  const pairs = [
    across("create_tag", "add_tag", 42, 39),
    across("upload", "add_tag", 42, 30),
    across("create_project", "create_tag", 40, 36),
  ];
  const packed = compactJourney(full, focus, { relations: pairs, tools: [], windowMinutes: 10 });
  const journeyPart = CASES.demo.packed;
  assert.deepEqual(packed.columns, journeyPart.columns, "no column is added");
  assert.equal(packed.width, journeyPart.width, "no wider than the journey part");
  const journeyBottom = Math.max(...journeyPart.nodes.map((n) => n.y + n.h));
  assert.deepEqual(packed.dividers, [
    { y: journeyBottom + 12, title: "Within 10 min in the same session" },
  ]);
  const rows = packed.nodes.filter((n) => n.key.startsWith("x:"));
  assert.equal(rows.length, 6, "two chips a row, so a tool in two pairs appears in each");
  const [c1, c2] = packed.columns;
  const pitch = JOURNEY_GRID.chipH + JOURNEY_GRID.chipGap;
  for (let row = 0; row < 3; row += 1) {
    const [first, tool] = [rows[row * 2], rows[row * 2 + 1]];
    assert.equal(first.x, c1.x, "the tool that ran first, in column 1");
    assert.equal(tool.x, c2.x, "the tool that needed it, in column 2");
    assert.equal(first.y, tool.y);
    assert.equal(first.y, journeyBottom + 34 + row * pitch, "one row each, stacked with no holes");
    assert.ok(first.y > journeyBottom + 20, "clear of the divider");
  }
  assert.deepEqual(
    rows.map((n) => n.key).slice(0, 2),
    ["x:create_tag>add_tag:first", "x:create_tag>add_tag:tool"],
    "heaviest pair first",
  );
  for (const link of packed.links ?? []) {
    const from = packed.nodes.find((n) => n.key === link.from)!;
    const to = packed.nodes.find((n) => n.key === link.to)!;
    assert.equal(link.x1, from.x + from.w);
    assert.equal(link.y1, link.y2, "a level link along its row");
    assert.ok(link.x2 > link.x1 && link.head.includes(`L${to.x} `), link.key);
  }
  for (let i = 0; i < packed.nodes.length; i += 1) {
    for (let j = i + 1; j < packed.nodes.length; j += 1)
      assert.ok(!boxesOverlap(packed.nodes[i], packed.nodes[j]));
  }
  assert.ok(!full.nodes.some((n) => n.key.startsWith("x:")), "the whole map never has them");
});

test("rows alone (Acme): two columns of their own, titled, starting at the edge", () => {
  const { full } = CASES.demo;
  const packed = compactJourney(full, NONE, {
    relations: [across("create_tag", "add_tag_to_task", 42, 39)],
    tools: [],
    windowMinutes: 10,
  });
  assert.deepEqual(
    packed.columns.map((c) => [c.role, c.title, c.x]),
    [
      ["across", "Ran first", JOURNEY_GRID.padX],
      ["across", "Within 10 min", JOURNEY_GRID.padX + JOURNEY_GRID.callWidth + JOURNEY_GRID.gap],
    ],
  );
  assert.deepEqual(
    packed.nodes.map((n) => n.key),
    ["x:create_tag>add_tag_to_task:first", "x:create_tag>add_tag_to_task:tool"],
  );
  assert.deepEqual(packed.dividers, [], "nothing above to divide from");
  assert.deepEqual(packed.ribbons, []);
  assert.equal(packed.links?.[0].key, "x:create_tag>add_tag_to_task");
  assert.equal(packed.links?.[0].crossTurn, true, "drawn dashed");
  const folded = compactJourney(full, NONE, {
    relations: [{ ...across("search_projects", "get_project_details", 21, 18), crossTurn: false }],
    tools: [],
    windowMinutes: 10,
  });
  assert.equal(
    folded.links?.[0].crossTurn,
    false,
    "a pair a turn held, but on a folded path, is drawn solid",
  );
});

test("the packed map fits a 1083 px card at 1440, and a phone scrolls it no wider than its journey part", () => {
  const CARD = 1083;
  const { full } = CASES.demo;
  const focus = journeyPrerequisiteFocus(full, DEMO_PAIRS).focus;
  const demoShape = compactJourney(full, focus, {
    relations: [{ ...across("search_projects", "get_project_details", 21, 18), crossTurn: false }],
    tools: [],
    windowMinutes: 10,
  });
  assert.ok(demoShape.width <= CARD, `demo: ${demoShape.width}`);
  assert.equal(
    demoShape.width,
    CASES.demo.packed.width,
    "a phone scrolls exactly as far as for the journey part",
  );
  const acmeShape = compactJourney(full, NONE, {
    relations: [across("create_tag", "add_tag_to_task", 42, 39)],
    tools: [],
    windowMinutes: 10,
  });
  assert.ok(acmeShape.width <= CARD, `acme: ${acmeShape.width}`);
  const deep = compactJourney(
    CASES.deep.full,
    journeyPrerequisiteFocus(CASES.deep.full, DEEP_PAIRS).focus,
    {
      relations: [across("x1", "x2", 30, 30), across("x3", "x4", 30, 28)],
      tools: [],
      windowMinutes: 10,
    },
  );
  assert.equal(deep.width, CASES.deep.packed.width);
  for (const node of [...demoShape.nodes, ...acmeShape.nodes, ...deep.nodes]) {
    assert.ok(node.x + node.w <= CARD, `${node.key} ends inside the card`);
  }
});
