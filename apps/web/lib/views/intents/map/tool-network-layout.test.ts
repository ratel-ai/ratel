import assert from "node:assert/strict";
import { test } from "node:test";
import * as force from "d3-force";
import { pointInPolygon } from "@/lib/views/intents/map/map-blobs";
import { buildToolNetwork, type ToolStep } from "@/lib/views/intents/map/tool-network";
import { DEMO_ROWS, mapModelFrom } from "@/lib/views/intents/map/tool-network-fixture";
import {
  ARROW,
  boundsWithNames,
  explanationSpot,
  groupHull,
  labelAngle,
  linkShape,
  NODE_RADIUS,
  nameSide,
  networkBounds,
  nudgeIntoView,
  packParts,
  ringSpots,
  settleNetwork,
} from "@/lib/views/intents/map/tool-network-layout";

const VIEW = { width: 1100, height: 580 };
const STEPS: ToolStep[] = [
  { from: "tool:lookup_order", to: "tool:stripe_refund_charge", n: 12, of: 30 },
  { from: "tool:stripe_search_customers", to: "tool:stripe_get_customer", n: 9, of: 20 },
];

function demo() {
  return buildToolNetwork({ model: mapModelFrom(DEMO_ROWS), steps: STEPS });
}

test("the network settles to the same place every time, before anything is drawn", () => {
  const network = demo();
  const first = settleNetwork(force, network, VIEW);
  const second = settleNetwork(force, network, VIEW);
  assert.deepEqual([...second], [...first], "no jitter between renders");
  assert.equal(first.size, network.nodes.length);
  for (const [id, mark] of first) {
    assert.ok(Number.isFinite(mark.x) && Number.isFinite(mark.y), `${id} is placed`);
    assert.ok(mark.r >= NODE_RADIUS.min && mark.r <= NODE_RADIUS.max, `${id} is sized by calls`);
  }
  const busiest = first.get("tool:lookup_order")!;
  const quietest = first.get("tool:vercel_rollback_production")!;
  assert.ok(busiest.r > quietest.r, "busier tools are larger");
});

test("marks never touch, and every colored group's hull holds its own tools and nobody else", () => {
  const network = demo();
  const marks = settleNetwork(force, network, VIEW);
  const list = [...marks];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [a, ma] = list[i]!;
      const [b, mb] = list[j]!;
      assert.ok(Math.hypot(ma.x - mb.x, ma.y - mb.y) >= ma.r + mb.r, `${a} and ${b} keep apart`);
    }
  }
  const colored = network.groups.filter((group) => group.color !== null);
  assert.ok(colored.length > 0);
  for (const group of colored) {
    const hull = groupHull(
      group.id,
      group.members.map((id) => marks.get(id)!),
    )!;
    for (const member of group.members)
      assert.ok(pointInPolygon(marks.get(member)!, hull.points), `${member} is inside ${group.id}`);
    for (const node of network.nodes) {
      if (node.group === group.id) continue;
      assert.equal(
        pointInPolygon(marks.get(node.id)!, hull.points),
        false,
        `${node.id} stays out of ${group.id}`,
      );
    }
  }
});

test("tools linked at rest sit nearer each other than tools that are not", () => {
  const network = demo();
  const marks = settleNetwork(force, network, VIEW);
  const distance = (a: string, b: string) =>
    Math.hypot(marks.get(a)!.x - marks.get(b)!.x, marks.get(a)!.y - marks.get(b)!.y);
  const linked = network.links
    .filter((link) => link.backbone)
    .map((link) => distance(link.source, link.target));
  const ids = network.nodes.map((node) => node.id);
  const unlinked: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (
        !network.links.some(
          (link) =>
            (link.source === ids[i] && link.target === ids[j]) ||
            (link.source === ids[j] && link.target === ids[i]),
        )
      ) {
        unlinked.push(distance(ids[i]!, ids[j]!));
      }
    }
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(
    mean(linked) * 2.5 < mean(unlinked),
    `linked ${mean(linked).toFixed(0)} vs unlinked ${mean(unlinked).toFixed(0)}`,
  );
});

test("parts are packed biggest first from the middle, apart, and wider in a wide view", () => {
  const discs = [60, 40, 40, 30, 20, 20, 20, 10, 10, 10].map((r, index) => ({
    id: `p${index}`,
    r,
  }));
  const homes = packParts(discs, 2);
  assert.deepEqual(homes.get("p0"), { x: 0, y: 0 }, "the biggest owns the middle");
  for (let i = 0; i < discs.length; i += 1) {
    for (let j = i + 1; j < discs.length; j += 1) {
      const a = homes.get(discs[i]!.id)!;
      const b = homes.get(discs[j]!.id)!;
      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y) >= discs[i]!.r + discs[j]!.r,
        `${discs[i]!.id} and ${discs[j]!.id} apart`,
      );
    }
  }
  const xs = [...homes.values()].map((home) => home.x);
  const ys = [...homes.values()].map((home) => home.y);
  assert.ok(
    Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys),
    "wider than tall",
  );
});

test("a link is a gentle curve between the marks' edges; an ordered one ends in an arrowhead short of its target", () => {
  const source = { x: 0, y: 0, r: 8 };
  const target = { x: 100, y: 0, r: 10 };
  const plain = linkShape(source, target, false)!;
  assert.equal(plain.arrow, null);
  const [, sx, sy] = plain.d.match(/^M(-?[\d.]+),(-?[\d.]+)Q/)!.map(Number);
  assert.ok(
    Math.abs(Math.hypot(sx!, sy!) - (source.r + 2)) < 0.2,
    "it leaves from the source's edge",
  );
  assert.ok(plain.mid.y > 0 || plain.mid.y < 0, "and bows to one side");
  const ordered = linkShape(source, target, true)!;
  const tip = ordered
    .arrow!.match(/^M(-?[\d.]+),(-?[\d.]+)L/)!
    .slice(1)
    .map(Number);
  assert.ok(
    Math.abs(Math.hypot(tip[0]! - target.x, tip[1]! - target.y) - (target.r + 2.5)) < 0.2,
    "the tip stops just short of the target",
  );
  const end = ordered.d
    .match(/ (-?[\d.]+),(-?[\d.]+)$/)!
    .slice(1)
    .map(Number);
  assert.ok(
    Math.abs(Math.hypot(end[0]! - target.x, end[1]! - target.y) - (target.r + 2.5 + ARROW.length)) <
      0.2,
    "the curve ends at the arrowhead's base",
  );
  assert.equal(
    linkShape(source, { x: 15, y: 0, r: 8 }, false),
    null,
    "marks that touch have no room for a link",
  );
});

test("bounds cover the marks and the hulls; a name faces away from its links", () => {
  assert.equal(networkBounds([], []), null);
  assert.deepEqual(
    networkBounds(
      [
        { x: 0, y: 0, r: 5 },
        { x: 50, y: 20, r: 10 },
      ],
      [{ minX: -30, minY: -4, maxX: 10, maxY: 4 }],
    ),
    {
      minX: -30,
      minY: -5,
      maxX: 60,
      maxY: 30,
    },
  );
  const angle = labelAngle({ x: 10, y: 0 }, [{ x: 0, y: 0 }], { x: 99, y: 99 })!;
  assert.ok(Math.abs(angle) < 1e-9, "partners on the left, name on the right");
  const alone = labelAngle({ x: 0, y: 10 }, [], { x: 0, y: 0 })!;
  assert.ok(Math.abs(alone - Math.PI / 2) < 1e-9, "alone, away from the middle");
  assert.equal(labelAngle({ x: 0, y: 0 }, [], { x: 0, y: 0 }), null);
});

test("a link's explanation sits beside its middle, inside the view, clear of its two tools and their names", () => {
  const view = { width: 800, height: 400 };
  const size = { width: 200, height: 60 };
  assert.deepEqual(
    explanationSpot({ x: 400, y: 200 }, size, [], view),
    { left: 300, top: 214 },
    "below by default",
  );
  const name = { left: 330, top: 220, width: 140, height: 16 };
  assert.deepEqual(
    explanationSpot({ x: 400, y: 200 }, size, [name], view),
    { left: 300, top: 126 },
    "above when a name is below",
  );
  assert.deepEqual(
    explanationSpot({ x: 790, y: 395 }, size, [], view),
    { left: 592, top: 332 },
    "kept inside the view",
  );
  const everywhere = [{ left: 0, top: 0, width: 800, height: 400 }];
  const spot = explanationSpot({ x: 400, y: 200 }, size, everywhere, view);
  assert.ok(spot.left >= 8 && spot.top >= 8, "with nowhere clear, it still lands inside");
});

test("tools linked to nothing ring the linked core, from the top, a second ring only when the first is full", () => {
  const first = { a: 360, b: 200 };
  const spots = ringSpots(10, first);
  assert.equal(spots.length, 10);
  assert.ok(
    Math.abs(spots[0]!.x) < 1e-3 && Math.abs(spots[0]!.y + first.b) < 1e-3,
    "the busiest sits at the top",
  );
  for (const spot of spots) {
    assert.ok(
      Math.abs(Math.abs(spot.x / first.a) ** 4 + Math.abs(spot.y / first.b) ** 4 - 1) < 0.01,
      "on the ring",
    );
  }
  const gaps = spots.map((spot, index) =>
    Math.hypot(
      spot.x - spots[(index + 1) % spots.length]!.x,
      spot.y - spots[(index + 1) % spots.length]!.y,
    ),
  );
  assert.ok(Math.max(...gaps) / Math.min(...gaps) < 1.15, "spread evenly along it");
  const many = ringSpots(200, { a: 40, b: 30 });
  assert.equal(many.length, 200);
  const reach = new Set(many.map((spot) => Math.round(Math.hypot(spot.x, spot.y) / 40)));
  assert.ok(reach.size > 1, "more than one ring");
  const network = buildToolNetwork({ model: mapModelFrom(DEMO_ROWS), steps: STEPS });
  const marks = settleNetwork(force, network, VIEW);
  const distance = (ids: string[]) =>
    ids.map((id) => Math.hypot(marks.get(id)!.x, marks.get(id)!.y));
  const lone = distance(network.nodes.filter((node) => node.partners === 0).map((node) => node.id));
  const linked = distance(network.nodes.filter((node) => node.partners > 0).map((node) => node.id));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(lone) > mean(linked) * 1.4, "lone tools sit well outside the linked ones");
  const core = networkBounds(
    network.nodes.filter((node) => node.partners > 0).map((node) => marks.get(node.id)!),
    [],
  )!;
  for (const node of network.nodes.filter((item) => item.partners === 0)) {
    const mark = marks.get(node.id)!;
    const inside =
      mark.x > core.minX && mark.x < core.maxX && mark.y > core.minY && mark.y < core.maxY;
    assert.equal(inside, false, `${node.id} sits outside the linked core`);
  }
});

test("a tool focused near an edge is panned just inside it; one already inside stays put", () => {
  const view = { width: 800, height: 400 };
  const t = { x: 0, y: 0, k: 2 };
  assert.deepEqual(nudgeIntoView({ x: 100, y: 100 }, t, view), t, "already inside");
  assert.deepEqual(
    nudgeIntoView({ x: 5, y: 100 }, t, view),
    { x: 38, y: 0, k: 2 },
    "from the left edge, just past the margin",
  );
  assert.deepEqual(
    nudgeIntoView({ x: 395, y: 190 }, t, view),
    { x: -38, y: -28, k: 2 },
    "from the bottom right corner",
  );
});

test("the fit makes room for each name on the side it faces, more of it the farther out the view is", () => {
  assert.equal(nameSide(null), "right");
  assert.equal(nameSide(Math.PI), "left");
  assert.equal(nameSide(Math.PI / 2), "below", "screen y runs down");
  assert.equal(nameSide(-Math.PI / 2), "above");
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const names = [
    { mark: { x: 0, y: 50, r: 5 }, side: "left" as const, width: 90 },
    { mark: { x: 100, y: 50, r: 5 }, side: "right" as const, width: 90 },
    { mark: { x: 50, y: 100, r: 5 }, side: "below" as const, width: 200 },
  ];
  assert.deepEqual(boundsWithNames(bounds, names, 1), {
    minX: -100,
    minY: 0,
    maxX: 200,
    maxY: 126,
  });
  const far = boundsWithNames(bounds, names, 0.5);
  assert.ok(far.maxX - far.minX > 300, "at half the zoom, a name takes twice the room");
});
