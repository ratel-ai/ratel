import assert from "node:assert/strict";
import { test } from "node:test";
import {
  polygonsMeet,
  seededRandom,
  signedDistance,
  smoothClosedCurve,
} from "@/lib/views/intents/map/map-blobs";
import { computeMapLayout } from "@/lib/views/intents/map/map-layout";
import {
  CORE_PAD,
  groupRings,
  type MapLayout,
  RING_GAP,
  TOOL_PAD,
  toolMemberships,
  WIDE_CLEAR,
  WIDE_FROM,
} from "@/lib/views/intents/map/map-membership";
import type {
  IntentMapModel,
  MapAsk,
  MapCapability,
  MapLink,
} from "@/lib/views/intents/map/map-model";
import {
  betweenSpot,
  meetingSpot,
  placeOnRing,
  STRETCH_ALLOW,
} from "@/lib/views/intents/map/map-placement";

test(`how many groups a tool answers decides where it sits: one inside, two or three in the overlap, ${WIDE_FROM} or more between`, () => {
  const memberships = toolMemberships([
    { ask: "status", capability: "update_task", weight: 52 },
    { ask: "create", capability: "create_task", weight: 62 },
    { ask: "move", capability: "update_task", weight: 17 },
    { ask: "a", capability: "trio", weight: 3 },
    { ask: "b", capability: "trio", weight: 5 },
    { ask: "c", capability: "trio", weight: 5 },
    ...["pr", "ci", "branch", "search"].map((ask, index) => ({
      ask,
      capability: "github",
      weight: 10 - index,
    })),
    { ask: "create", capability: "ghost", weight: 0 },
  ]);
  assert.deepEqual(memberships.get("create_task"), { membership: "single", groups: ["create"] });
  assert.deepEqual(
    memberships.get("update_task"),
    { membership: "shared", groups: ["status", "move"] },
    "busiest group first",
  );
  assert.deepEqual(
    memberships.get("trio"),
    { membership: "shared", groups: ["b", "c", "a"] },
    "ties by id",
  );
  assert.equal(memberships.get("github")?.membership, "wide");
  assert.equal(memberships.has("ghost"), false, "a link with no calls places nothing");
});

test("a group's rings: its tools sit just outside the core, its body a pad beyond them", () => {
  assert.deepEqual(
    groupRings(30, []).body,
    30 + CORE_PAD,
    "a group that holds no tool is its core",
  );
  const rings = groupRings(30, [4, 6]);
  assert.equal(rings.ring, 30 + RING_GAP + 6);
  assert.equal(rings.body, rings.ring + 6 + TOOL_PAD);
  assert.ok(rings.reach > rings.body);
  const crowded = groupRings(
    22,
    Array.from({ length: 16 }, () => 6),
  );
  assert.ok(crowded.ring > 22 + RING_GAP + 6, "a group holding many tools gets a wider ring");
});

test("a group's own tools gather at the bottom of its ring, apart, and around what is in the way", () => {
  const centre = { x: 0, y: 0 };
  const spots = placeOnRing(
    centre,
    [40],
    [
      { id: "a", r: 6 },
      { id: "b", r: 5 },
      { id: "c", r: 4 },
    ],
    () => true,
  );
  const a = spots.get("a")!;
  assert.ok(Math.abs(a.x) < 1e-6 && Math.abs(a.y - 40) < 1e-6, "the busiest hangs at the bottom");
  for (const [id, spot] of spots) {
    assert.ok(Math.abs(Math.hypot(spot.x, spot.y) - 40) < 1e-6, `${id} is on the ring`);
    assert.ok(spot.y > 0, `${id} is in the lower half`);
  }
  assert.ok(
    Math.hypot(a.x - spots.get("b")!.x, a.y - spots.get("b")!.y) >= 6 + 5 + 4,
    "marks never touch",
  );
  const blocked = placeOnRing(centre, [40], [{ id: "a", r: 6 }], (spot) => spot.x < -10);
  assert.ok(
    blocked.get("a")!.x < -10,
    "a spot that is in the way is skipped for the nearest free one",
  );
  const crowdedRing = placeOnRing(
    centre,
    [40, 56],
    [{ id: "a", r: 6 }],
    (spot) => Math.hypot(spot.x, spot.y) > 50,
  );
  assert.ok(
    Math.abs(Math.hypot(crowdedRing.get("a")!.x, crowdedRing.get("a")!.y) - 56) < 1e-6,
    "with no room on the ring, it sits further out",
  );
});

test("a tool two or three groups share sits where their rings overlap, off their cores", () => {
  const group = (id: string, x: number, y: number) => ({
    id,
    x,
    y,
    r: 30,
    rings: groupRings(30, [6]),
  });
  const a = group("a", 0, 0);
  const b = group("b", 70, 0);
  const meeting = meetingSpot({ r: 6 }, [a, b], [], [])!;
  assert.ok(meeting.bulge <= 0.5, "both bodies hold it as they are");
  for (const member of [a, b]) {
    const distance = Math.hypot(meeting.spot.x - member.x, meeting.spot.y - member.y);
    assert.ok(
      distance + 6 + TOOL_PAD <= member.rings.body + 0.5 &&
        distance >= member.r + RING_GAP + 6 - 1e-6,
      `${member.id}: in its body, off its core`,
    );
  }
  // Three groups set round one spot, each its ring away from it.
  const side = a.rings.ring * Math.sqrt(3);
  const three = meetingSpot(
    { r: 6 },
    [a, group("b2", side, 0), group("c", side / 2, side * (Math.sqrt(3) / 2))],
    [],
    [],
  )!;
  assert.ok(three.bulge <= 0.5, "three bodies meet around one spot");
  const far = meetingSpot({ r: 6 }, [a, group("d", 300, 0)], [], [])!;
  assert.ok(far.bulge > 50, "groups too far apart could only hold it by stretching");
  const blocked = meetingSpot({ r: 6 }, [a, b], [group("e", 35, 0)], []);
  assert.ok(
    blocked === null || blocked.bulge > a.rings.body * STRETCH_ALLOW,
    "never inside a group it does not belong to, so too far to hold",
  );
});

// --- the whole layout ----------------------------------------------------------

function model(
  groups: Array<[string, number]>,
  links: Array<[string, string, number]>,
): IntentMapModel {
  const asks: MapAsk[] = groups.map(([id, volume]) => ({
    id,
    label: `ask ${id}`,
    volume,
    phrasings: 1,
    firstTry: null,
    rankedByGraph: 0,
    problem: null,
  }));
  const capabilities = new Map<string, MapCapability>();
  for (const [, capability, weight] of links) {
    const current = capabilities.get(capability) ?? {
      id: capability,
      kind: "tool" as const,
      name: capability.slice(5),
      calls: 0,
      asks: 0,
      missing: false,
    };
    capabilities.set(capability, {
      ...current,
      calls: current.calls + weight,
      asks: current.asks + 1,
    });
  }
  const totals = new Map<string, number>();
  for (const [ask, , weight] of links) totals.set(ask, (totals.get(ask) ?? 0) + weight);
  const mapLinks: MapLink[] = links.map(([ask, capability, weight]) => ({
    ask,
    capability,
    weight,
    share: weight / totals.get(ask)!,
  }));
  return {
    asks,
    capabilities: [...capabilities.values()].sort((a, b) => b.calls - a.calls),
    links: mapLinks,
    hidden: null,
  };
}

/** A crowded map: 60 groups, each with its own tools, many sharing one with a neighbour or two, a few tools shared widely. */
function crowded(seed: number): IntentMapModel {
  const random = seededRandom(seed);
  const groups: Array<[string, number]> = Array.from({ length: 60 }, (_, index) => [
    `g${index}`,
    Math.max(1, Math.round(120 * random() ** 2.2)),
  ]);
  const links: Array<[string, string, number]> = [];
  let next = 0;
  for (const [id] of groups) {
    for (let own = 0; own < 1 + Math.floor(random() * 3); own += 1)
      links.push([id, `tool:t${next++}`, 1 + Math.floor(random() * 40)]);
  }
  for (let shared = 0; shared < 24; shared += 1) {
    const first = Math.floor(random() * 60);
    const count = random() < 0.7 ? 2 : 3;
    const tool = `tool:s${next++}`;
    const used = new Set<number>();
    for (let member = 0; member < count; member += 1) {
      let index = (first + Math.floor(random() * 6)) % 60;
      while (used.has(index)) index = (index + 1) % 60;
      used.add(index);
      links.push([`g${index}`, tool, 1 + Math.floor(random() * 30)]);
    }
  }
  for (let wide = 0; wide < 6; wide += 1) {
    const tool = `tool:w${next++}`;
    const used = new Set<number>();
    for (let member = 0; member < 4 + Math.floor(random() * 5); member += 1) {
      let index = Math.floor(random() * 60);
      while (used.has(index)) index = (index + 1) % 60;
      used.add(index);
      links.push([`g${index}`, tool, 1 + Math.floor(random() * 20)]);
    }
  }
  return model(groups, links);
}

/** Every rule the drawing promises, checked on the curves the reader sees. */
function assertRules(layout: MapLayout, input: IntentMapModel) {
  const curves = new Map(
    [...layout.groups].map(([id, group]) => [id, smoothClosedCurve(group.blob.points, 8)]),
  );
  const memberships = toolMemberships(input.links);
  for (const node of layout.nodes.values()) {
    const membership = memberships.get(node.id)!;
    assert.equal(node.membership, membership.membership);
    if (node.membership === "single")
      assert.equal(node.placement, "inside", `${node.id} is inside its group`);
    if (node.membership === "wide")
      assert.equal(node.placement, "between", `${node.id} is shared widely, so between`);
    for (const [id, curve] of curves) {
      const member = node.groups.includes(id);
      const { bounds } = layout.groups.get(id)!.blob;
      const room = node.r + WIDE_CLEAR + 2;
      // Far from a blob's box is clear of it; only nearby blobs are measured.
      if (
        !member &&
        (node.x < bounds.minX - room ||
          node.x > bounds.maxX + room ||
          node.y < bounds.minY - room ||
          node.y > bounds.maxY + room)
      )
        continue;
      const clearance = signedDistance(node, curve);
      if (node.placement !== "between" && member) {
        assert.ok(
          clearance >= node.r + TOOL_PAD - 1,
          `${node.id} sits clearly inside ${id}, not on its outline`,
        );
        const group = layout.groups.get(id)!;
        assert.ok(
          Math.hypot(node.x - group.x, node.y - group.y) >= group.r + RING_GAP + node.r - 1e-6,
          `${node.id} stays off ${id}'s core, where the name sits`,
        );
      } else {
        const clear = node.placement === "between" ? WIDE_CLEAR : TOOL_PAD;
        assert.ok(
          clearance <= -(node.r + clear) + 1,
          `${node.id} is outside ${id}, which it does not ${member ? "sit in" : "belong to"}`,
        );
      }
    }
  }
  // An overlap always means a shared tool.
  const related = new Set<string>();
  for (const { membership, groups } of memberships.values()) {
    if (membership === "shared")
      for (const a of groups) for (const b of groups) related.add(`${a}|${b}`);
  }
  const ids = [...layout.groups.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (related.has(`${ids[i]}|${ids[j]}`)) continue;
      // The outline's own samples are within a hair of its curve, and groups sharing nothing keep a gap.
      assert.ok(
        !polygonsMeet(
          layout.groups.get(ids[i]!)!.blob.points,
          layout.groups.get(ids[j]!)!.blob.points,
        ),
        `${ids[i]} and ${ids[j]} share nothing, so they do not overlap`,
      );
    }
  }
  // Every name's room is inside its own blob.
  for (const [id, group] of layout.groups) {
    assert.ok(
      signedDistance(group.name, curves.get(id)!) >= group.name.r - 0.5,
      `${id}'s name room is inside its blob`,
    );
  }
}

test("one, two or three, and many: each tool sits where its membership says", () => {
  const input = model(
    [
      ["solo", 40],
      ["pair-a", 30],
      ["pair-b", 20],
      ["trio-a", 25],
      ["trio-b", 25],
      ["trio-c", 15],
      ["w1", 10],
      ["w2", 12],
      ["w3", 8],
      ["w4", 6],
    ],
    [
      ["solo", "tool:mine", 20],
      ["solo", "tool:also-mine", 5],
      ["pair-a", "tool:pair", 10],
      ["pair-b", "tool:pair", 6],
      ["trio-a", "tool:trio", 4],
      ["trio-b", "tool:trio", 4],
      ["trio-c", "tool:trio", 4],
      ...["w1", "w2", "w3", "w4"].map((ask): [string, string, number] => [ask, "tool:wide", 3]),
      ...["w1", "w2", "w3", "w4"].map((ask): [string, string, number] => [
        ask,
        `tool:own-${ask}`,
        5,
      ]),
    ],
  );
  const layout = computeMapLayout(input, { width: 1100, height: 600 });
  assert.equal(layout.nodes.get("tool:mine")!.placement, "inside");
  assert.equal(
    layout.nodes.get("tool:pair")!.placement,
    "overlap",
    "two groups pulled together around it",
  );
  assert.equal(layout.nodes.get("tool:trio")!.placement, "overlap", "three groups meet around it");
  assert.equal(layout.nodes.get("tool:wide")!.placement, "between");
  assert.ok(
    polygonsMeet(
      layout.groups.get("pair-a")!.blob.points,
      layout.groups.get("pair-b")!.blob.points,
    ),
    "their blobs overlap",
  );
  assertRules(layout, input);
  assert.deepEqual(
    computeMapLayout(input, { width: 1100, height: 600 }),
    layout,
    "the same model lays out the same way every time",
  );
});

test("a crowded map of 60 groups keeps every rule", () => {
  for (const seed of [1, 2, 3]) {
    const input = crowded(seed);
    const layout = computeMapLayout(input, { width: 1100, height: 600 });
    assert.equal(layout.groups.size, 60);
    assertRules(layout, input);
    const shared = [...layout.nodes.values()].filter((node) => node.membership === "shared");
    const held = shared.filter((node) => node.placement === "overlap");
    assert.ok(
      held.length >= shared.length * 0.6,
      `seed ${seed}: most shared tools sit in an overlap (${held.length} of ${shared.length})`,
    );
  }
});

test("a tool between groups takes the free spot nearest their middle", () => {
  const blob = (x: number) => ({
    cx: x,
    cy: 0,
    radii: [],
    points: Array.from({ length: 32 }, (_, index) => ({
      x: x + Math.cos((index / 32) * Math.PI * 2) * 30,
      y: Math.sin((index / 32) * Math.PI * 2) * 30,
    })),
    path: "",
    bounds: { minX: x - 30, minY: -30, maxX: x + 30, maxY: 30 },
  });
  const spot = betweenSpot(
    { r: 5 },
    [
      { x: -40, y: 0 },
      { x: 40, y: 0 },
    ],
    [blob(-40), blob(40)],
    [],
  );
  assert.ok(
    Math.abs(spot.x) < 1e-6 && Math.abs(spot.y) <= 45,
    "between the two, just clear of both",
  );
  assert.ok(
    Math.min(Math.hypot(spot.x + 40, spot.y), Math.hypot(spot.x - 40, spot.y)) >=
      30 + 5 + WIDE_CLEAR - 1,
  );
});
