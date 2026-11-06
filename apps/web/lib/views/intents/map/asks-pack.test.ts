import assert from "node:assert/strict";
import { test } from "node:test";
import { hierarchy, pack } from "d3-hierarchy";
import type { IntentAsksTree } from "@/lib/views/intents/asks-tree";
import {
  ASKS_SPACE,
  groupKey,
  intentKey,
  LABEL_OPEN_RADIUS,
  labelSpots,
  layoutAsks,
  pathTo,
  ROOT,
  resolveFocus,
  stepToward,
  wayKey,
  zoomedInto,
} from "@/lib/views/intents/map/asks-pack";

const way = (id: string, asks: number) => ({ id, label: `ask like ${id}`, asks });

/** Delivery: three things asked for, the first asked three ways, the third once; and two more not listed. */
const delivery: IntentAsksTree = {
  topicId: "t_delivery",
  asks: 100,
  read: 110,
  capped: false,
  skipped: false,
  groups: [
    {
      id: "g_po",
      label: "Check PO delivery status",
      quoted: false,
      asks: 60,
      ways: [way("c1", 30), way("c2", 20), way("c3", 6)],
      restAsks: 4,
      restWays: 2,
    },
    {
      id: "g_track",
      label: "Track a shipment",
      quoted: false,
      asks: 25,
      ways: [way("c4", 15), way("c5", 10)],
      restAsks: 0,
      restWays: 0,
    },
    {
      id: "g_late",
      label: "when is it late",
      quoted: true,
      asks: 10,
      ways: [],
      restAsks: 0,
      restWays: 0,
    },
  ],
  restAsks: 5,
  restGroups: 2,
};

/** RFI: one thing only, so its ways stand for it. */
const rfi: IntentAsksTree = {
  topicId: "t_rfi",
  asks: 40,
  read: 40,
  capped: false,
  skipped: true,
  groups: [
    {
      id: "g_rfi",
      label: "Find who owns an RFI",
      quoted: false,
      asks: 40,
      ways: [way("c9", 28), way("c10", 12)],
      restAsks: 0,
      restWays: 0,
    },
  ],
  restAsks: 0,
  restGroups: 0,
};

const INTENTS = [
  { id: "t_delivery", asks: 120 },
  { id: "t_rfi", asks: 45 },
  { id: "t_spec", asks: 30 },
  { id: "t_none", asks: 0 },
];

const KIT = { hierarchy, pack };
const layout = () =>
  layoutAsks(
    INTENTS,
    new Map([
      ["t_delivery", delivery],
      ["t_rfi", rfi],
    ]),
    KIT,
  );
const inside = (
  child: { x: number; y: number; r: number },
  parent: { x: number; y: number; r: number },
) => Math.hypot(child.x - parent.x, child.y - parent.y) + child.r <= parent.r + 1e-6;

test("every intent with asks is a circle, busiest first and largest; one with none is left out", () => {
  const { children, byKey, bounds } = layout();
  const tops = children.get(ROOT)!.map((key) => byKey.get(key)!);
  assert.deepEqual(
    tops.map((node) => node.intent),
    ["t_delivery", "t_rfi", "t_spec"],
  );
  assert.ok(tops[0]!.r > tops[1]!.r && tops[1]!.r > tops[2]!.r, "as large as its asks");
  assert.ok(bounds.minX >= 0 && bounds.maxX <= ASKS_SPACE && bounds.maxY <= ASKS_SPACE);
});

test("inside an intent, what they ask for; inside each, the ways people ask it; a rest keeps the unlisted asks", () => {
  const { children, byKey } = layout();
  const intent = byKey.get(intentKey("t_delivery"))!;
  assert.deepEqual(children.get(intent.key), [
    groupKey("t_delivery", "g_po"),
    groupKey("t_delivery", "g_track"),
    groupKey("t_delivery", "g_late"),
    "r:i:t_delivery",
  ]);
  const po = byKey.get(groupKey("t_delivery", "g_po"))!;
  assert.equal(po.depth, 2);
  assert.equal(po.asks, 60, "its ways and its rest add up to its asks");
  assert.deepEqual(children.get(po.key), [
    wayKey("t_delivery", "g_po", "c1"),
    wayKey("t_delivery", "g_po", "c2"),
    wayKey("t_delivery", "g_po", "c3"),
    `r:${po.key}`,
  ]);
  const rest = byKey.get("r:i:t_delivery")!;
  assert.deepEqual([rest.kind, rest.asks, rest.count], ["rest", 5, 2]);
  for (const node of layout().nodes) {
    if (node.parent === ROOT) continue;
    assert.ok(inside(node, byKey.get(node.parent)!), `${node.key} sits inside ${node.parent}`);
  }
});

test("a level with one child is skipped: an intent that is one thing holds its ways; a thing asked one way holds nothing", () => {
  const { children, byKey } = layout();
  const ways = children.get(intentKey("t_rfi"))!.map((key) => byKey.get(key)!);
  assert.deepEqual(
    ways.map((node) => [node.kind, node.depth, node.way]),
    [
      ["way", 2, "c9"],
      ["way", 2, "c10"],
    ],
  );
  assert.deepEqual(children.get(groupKey("t_delivery", "g_late")), []);
  assert.deepEqual(children.get(intentKey("t_spec")), [], "not read yet: a plain circle");
});

test("the layout is the same every time, and the intents stay put when their insides arrive", () => {
  assert.deepEqual(layout().nodes, layout().nodes);
  const bare = layoutAsks(INTENTS, new Map(), KIT);
  const full = layout();
  for (const key of bare.children.get(ROOT)!) {
    const [a, b] = [bare.byKey.get(key)!, full.byKey.get(key)!];
    assert.deepEqual([a.x, a.y, a.r], [b.x, b.y, b.r]);
  }
});

test("a click goes one level in at a time, toward what was hit; outside the focus it moves to that intent", () => {
  const l = layout();
  const c2 = wayKey("t_delivery", "g_po", "c2");
  assert.deepEqual(pathTo(l, c2), [intentKey("t_delivery"), groupKey("t_delivery", "g_po"), c2]);
  assert.equal(stepToward(l, ROOT, c2), intentKey("t_delivery"));
  assert.equal(stepToward(l, intentKey("t_delivery"), c2), groupKey("t_delivery", "g_po"));
  assert.equal(stepToward(l, groupKey("t_delivery", "g_po"), c2), c2, "a way is the last step");
  assert.equal(stepToward(l, c2, c2), c2);
  assert.equal(
    stepToward(l, groupKey("t_delivery", "g_po"), intentKey("t_rfi")),
    intentKey("t_rfi"),
  );
  assert.deepEqual(pathTo(l, "nope"), []);
});

test("no intent with asks lays out nothing", () => {
  const empty = layoutAsks([{ id: "t", asks: 0 }], new Map(), KIT);
  assert.equal(empty.nodes.length, 0);
});

test("labels follow the zoom: names on circles large enough, counts on smaller ones, and a grown circle hands its centre to its own", () => {
  const l = layout();
  for (const k of [0.15, 0.3, 0.6, 1, 2]) {
    const spots = labelSpots(l, ROOT, { x: 0, y: 0, k });
    const at = new Map(spots.map((spot) => [spot.key, spot]));
    for (const spot of spots) {
      const node = l.byKey.get(spot.key)!;
      const r = node.r * k;
      const inner = l.children.get(spot.key)!;
      if (spot.mode === "edge") {
        assert.ok(
          r >= LABEL_OPEN_RADIUS && inner.length > 0,
          `${spot.key} opens only when grown and holding circles`,
        );
        assert.ok(
          inner.every(
            (child) =>
              at.get(child)?.mode !== "edge" || l.byKey.get(child)!.r * k >= LABEL_OPEN_RADIUS,
          ),
        );
      } else {
        assert.ok(
          r < LABEL_OPEN_RADIUS || inner.length === 0,
          `${spot.key} at ${k}: a grown circle hands its centre on`,
        );
        assert.ok(
          inner.every((child) => !at.has(child)),
          "a circle carrying its name keeps its own circles quiet",
        );
      }
      if (spot.mode === "count") assert.ok(r < 34, "a count only where a name will not fit");
      if (node.parent !== ROOT)
        assert.equal(
          at.get(node.parent)?.mode,
          "edge",
          "deeper labels only inside an opened circle",
        );
      assert.ok(spot.fontSize >= 12 && spot.width <= 240);
    }
  }
  const fitted = labelSpots(l, ROOT, { x: 0, y: 0, k: 0.3 });
  assert.ok(
    fitted.every((spot) => spot.kind === "intent"),
    "at a calm zoom, the intents alone",
  );
  const close = labelSpots(l, ROOT, { x: 0, y: 0, k: 2 });
  assert.ok(
    close.some((spot) => spot.kind === "way"),
    "close up, the ways people ask it",
  );
  assert.deepEqual(labelSpots(l, ROOT, { x: 0, y: 0, k: 0.01 }), [], "nothing at a far zoom");
});

test("a zoom goes into the circle under the point once it fills most of the view, never into a leaf", () => {
  const l = layout();
  const delivery = l.byKey.get(intentKey("t_delivery"))!;
  const view = { width: 1000, height: 600 };
  const centredAt = (k: number) => ({
    k,
    x: view.width / 2 - delivery.x * k,
    y: view.height / 2 - delivery.y * k,
  });
  const middle = { x: view.width / 2, y: view.height / 2 };
  assert.equal(zoomedInto(l, ROOT, centredAt(0.5), middle, view), null, "not yet");
  assert.equal(zoomedInto(l, ROOT, centredAt(1.5), middle, view), intentKey("t_delivery"));
  assert.equal(
    zoomedInto(l, ROOT, centredAt(1.5), { x: 0, y: 0 }, view),
    null,
    "the point is outside it",
  );
  const late = l.byKey.get(groupKey("t_delivery", "g_late"))!;
  const onLate = { k: 40, x: view.width / 2 - late.x * 40, y: view.height / 2 - late.y * 40 };
  assert.equal(
    zoomedInto(l, intentKey("t_delivery"), onLate, middle, view),
    null,
    "asked one way: nothing to go into",
  );
});

test("a focus key resolves to its circle, its intent when it is gone, or the root; a way or a rest focuses where it sits", () => {
  const l = layout();
  assert.equal(resolveFocus(l, null), ROOT);
  assert.equal(resolveFocus(l, groupKey("t_delivery", "g_po")), groupKey("t_delivery", "g_po"));
  assert.equal(
    resolveFocus(l, groupKey("t_delivery", "renamed")),
    intentKey("t_delivery"),
    "a rebuild reshuffled the group",
  );
  assert.equal(resolveFocus(l, wayKey("t_delivery", "g_po", "c1")), groupKey("t_delivery", "g_po"));
  assert.equal(resolveFocus(l, intentKey("t_gone")), ROOT);
  assert.equal(
    resolveFocus(l, "r:g:t_delivery:gone"),
    intentKey("t_delivery"),
    "a rest inside a renamed group",
  );
});

test("a circle is as large as its asks among its siblings, however many circles it holds", () => {
  const even: IntentAsksTree = {
    topicId: "t_even",
    asks: 1000,
    read: 1000,
    capped: false,
    skipped: false,
    groups: [
      {
        id: "g_many",
        label: "Many ways",
        quoted: false,
        asks: 500,
        ways: [way("a", 100), way("b", 100), way("c", 100), way("d", 100), way("e", 100)],
        restAsks: 0,
        restWays: 0,
      },
      {
        id: "g_one",
        label: "One way",
        quoted: false,
        asks: 500,
        ways: [],
        restAsks: 0,
        restWays: 0,
      },
    ],
    restAsks: 0,
    restGroups: 0,
  };
  const l = layoutAsks([{ id: "t_even", asks: 1000 }], new Map([["t_even", even]]), KIT);
  const [many, one] = [
    l.byKey.get(groupKey("t_even", "g_many"))!,
    l.byKey.get(groupKey("t_even", "g_one"))!,
  ];
  assert.ok(
    Math.abs(many.r - one.r) / one.r < 0.01,
    `equal asks, equal circles: ${many.r} and ${one.r}`,
  );
  const ways = l.children.get(many.key)!.map((key) => l.byKey.get(key)!);
  assert.equal(ways.length, 5);
  assert.ok(
    ways.every((node) => Math.abs(node.r - ways[0]!.r) / ways[0]!.r < 0.01),
    "and so do its ways",
  );
});

test("each circle knows the asks its circles share, so its counts read as N of the asks read", () => {
  const l = layout();
  assert.equal(
    l.byKey.get(intentKey("t_delivery"))!.of,
    100,
    "the intent's grouped asks, not its 120 turns",
  );
  assert.equal(l.byKey.get(groupKey("t_delivery", "g_po"))!.of, 60);
  assert.equal(
    l.byKey.get(groupKey("t_delivery", "g_late"))!.of,
    0,
    "a thing asked one way holds nothing",
  );
  assert.equal(l.byKey.get(intentKey("t_spec"))!.of, 0);
});
