/**
 * Where the tool network sits, and the shapes drawn from it: a force layout
 * settled once, before the first paint, and the same every time for the same
 * network; then the soft hull behind each colored group and the gentle curve
 * of each link. Pure: `d3-force` is handed in (the page loads it lazily in
 * the browser; tests pass the real module), and its random source is the
 * seeded one it ships with, so nothing jitters between renders.
 *
 * The layout: tools that are linked, directly or through others, form one
 * part; parts are packed biggest first from the middle outward along a
 * spiral, stretched to the view's shape, so the busiest part owns the middle.
 * Tools linked to nothing sit apart, on a quiet ring around the linked core,
 * so what is connected reads at a glance. Inside a part, links pull, marks
 * keep apart, and a tool that is not in a colored group is kept out of that
 * group's hull, so a hull never seems to hold a tool it does not.
 */
import type * as Force from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { hullRadii, samplesFor, smoothClosedPath, wobble } from "@/lib/views/intents/map/map-blobs";
import {
  type Bounds,
  type Circle,
  type Point,
  radiusFor,
} from "@/lib/views/intents/map/map-geometry";
import type { ToolNetworkModel } from "@/lib/views/intents/map/tool-network";

export type ForceModule = Pick<
  typeof Force,
  "forceSimulation" | "forceLink" | "forceManyBody" | "forceCollide" | "forceX" | "forceY"
>;

/** A tool's mark, by its calls (map units). */
export const NODE_RADIUS = { min: 5, max: 13 };
/** A colored group's hull runs this far outside its marks. */
export const HULL_PAD = 16;
/** Between two marks, at least, so a name has somewhere to go. */
export const MARK_GAP = 18;
/** An arrowhead's length and half its width (map units). */
export const ARROW = { length: 8, half: 4 };
/** Room each tool takes in its part, mark included, when parts are packed. */
const ROOM = 36;
/** Between two packed parts: room for the names that face each other across it. */
const PART_GAP = 34;
/** Tools linked to nothing sit on a ring this far outside the linked core as it settled: wider across, where names run... */
const RING_GAP = { x: 120, y: 48 };
/** ...at least this far apart along it (map units)... */
const RING_SPACING = 72;
/** ...and on a further ring, this much farther out, when one is full. */
const RING_STEP = 44;
/** A link's rest length beyond its two marks: the stronger, the shorter. */
const LINK_REST = { min: 48, max: 96 };
const TICKS = 300;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** How far a hull wanders outward, as a share of its reach: a little, like the map's blobs. */
const HULL_WOBBLE = 0.04;
/** The bend of a link's curve, as a share of its length. */
const BEND = 0.12;

/** How hard a linked tool is held near its part's home: loosely, its links place it. */
const HOME_PULL = 0.07;

type SimNode = SimulationNodeDatum & {
  id: string;
  r: number;
  hx: number;
  hy: number;
  group: string | null;
};
type SimLink = SimulationLinkDatum<SimNode> & { strength: number };

const round = (value: number) => Math.round(value * 10) / 10;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A tool's mark radius on a square-root scale of its calls, so area tracks the number. */
export function networkRadius(calls: number, maxCalls: number): number {
  return radiusFor(calls, maxCalls, NODE_RADIUS);
}

/** Tools linked at rest, directly or through others: one part each, biggest first. */
function partsOf(network: ToolNetworkModel): string[][] {
  const parent = new Map(network.nodes.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const link of network.links) {
    if (!link.backbone) continue;
    const a = find(link.source);
    const b = find(link.target);
    if (a !== b) parent.set(byId(a, b) <= 0 ? b : a, byId(a, b) <= 0 ? a : b);
  }
  const calls = new Map(network.nodes.map((node) => [node.id, node.calls]));
  const parts = new Map<string, string[]>();
  for (const node of network.nodes) {
    const root = find(node.id);
    const list = parts.get(root);
    if (list) list.push(node.id);
    else parts.set(root, [node.id]);
  }
  const total = (part: string[]) => part.reduce((sum, id) => sum + (calls.get(id) ?? 0), 0);
  return [...parts.values()].sort(
    (a, b) => b.length - a.length || total(b) - total(a) || byId(a[0]!, b[0]!),
  );
}

/**
 * Packs discs biggest first: each takes the first spot along a spiral from
 * the middle where it meets nothing placed, the spiral stretched to `aspect`
 * (width over height) so the pack fills a wide view.
 */
export function packParts(
  discs: ReadonlyArray<{ id: string; r: number }>,
  aspect: number,
  gap = PART_GAP,
): Map<string, Point> {
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const placed: Circle[] = [];
  const out = new Map<string, Point>();
  for (const disc of discs) {
    let spot: Point = { x: 0, y: 0 };
    for (let step = 0; step < 40_000; step += 1) {
      const angle = step * 0.18;
      const reach = step * 0.9;
      const candidate = { x: Math.cos(angle) * reach * sx, y: Math.sin(angle) * reach * sy };
      if (
        placed.every(
          (other) =>
            Math.hypot(other.x - candidate.x, other.y - candidate.y) >= other.r + disc.r + gap,
        )
      ) {
        spot = candidate;
        break;
      }
    }
    placed.push({ ...spot, r: disc.r });
    out.set(disc.id, spot);
  }
  return out;
}

/** A ring's shape: a superellipse this square, round enough to read as a ring, square enough to fill a wide view. */
const RING_SQUARENESS = 4;
/** Points the ring is measured through, to space tools evenly along it. */
const RING_SAMPLES = 720;

/** Points along a superellipse `a` across and `b` down, from its top, clockwise on screen. */
function ringOutline(a: number, b: number): Point[] {
  const power = 2 / RING_SQUARENESS;
  return Array.from({ length: RING_SAMPLES + 1 }, (_, index) => {
    const t = -Math.PI / 2 + (index / RING_SAMPLES) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return {
      x: a * Math.sign(c) * Math.abs(c) ** power,
      y: b * Math.sign(s) * Math.abs(s) ** power,
    };
  });
}

/**
 * Spots for `count` lone tools on rings around the middle, the first ring
 * `first.a` across and `first.b` down, each further one `RING_STEP` out, the
 * inner ring filled first. A ring is a superellipse, which holds a box's
 * corners where an ellipse would cut them; tools are spread evenly along it
 * from the top, at least `RING_SPACING` apart.
 */
export function ringSpots(count: number, first: { a: number; b: number }): Point[] {
  const out: Point[] = [];
  for (let ring = 0; out.length < count; ring += 1) {
    const outline = ringOutline(first.a + ring * RING_STEP, first.b + ring * RING_STEP);
    const along = [0];
    for (let index = 1; index < outline.length; index += 1) {
      along.push(
        along[index - 1]! +
          Math.hypot(
            outline[index]!.x - outline[index - 1]!.x,
            outline[index]!.y - outline[index - 1]!.y,
          ),
      );
    }
    const perimeter = along[along.length - 1]!;
    const here = Math.min(Math.max(1, Math.floor(perimeter / RING_SPACING)), count - out.length);
    // A second ring's tools sit between the first's.
    const offset = ring % 2 === 0 ? 0 : 0.5;
    let cursor = 0;
    for (let slot = 0; slot < here; slot += 1) {
      const target = ((slot + offset) / here) * perimeter;
      while (cursor < along.length - 2 && along[cursor + 1]! < target) cursor += 1;
      const span = along[cursor + 1]! - along[cursor]! || 1;
      const t = (target - along[cursor]!) / span;
      const from = outline[cursor]!;
      const to = outline[cursor + 1]!;
      out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return out;
}

/**
 * Keeps every tool outside the hull of a colored group it is not in: each
 * tick, a group's reach is measured from its middle, and an outsider within
 * it is pushed back out, a little more the deeper it is.
 */
function keepOutOfGroups(nodes: SimNode[], colored: ReadonlySet<string>) {
  const force = (alpha: number) => {
    for (const group of colored) {
      const members = nodes.filter((node) => node.group === group);
      if (members.length === 0) continue;
      const cx = members.reduce((sum, node) => sum + (node.x ?? 0), 0) / members.length;
      const cy = members.reduce((sum, node) => sum + (node.y ?? 0), 0) / members.length;
      const reach =
        Math.max(
          ...members.map((node) => Math.hypot((node.x ?? 0) - cx, (node.y ?? 0) - cy) + node.r),
        ) + HULL_PAD;
      for (const node of nodes) {
        if (node.group === group) continue;
        const dx = (node.x ?? 0) - cx;
        const dy = (node.y ?? 0) - cy;
        const distance = Math.hypot(dx, dy) || 1;
        const overlap = reach + node.r + 4 - distance;
        if (overlap <= 0) continue;
        node.vx = (node.vx ?? 0) + (dx / distance) * overlap * 0.5 * alpha;
        node.vy = (node.vy ?? 0) + (dy / distance) * overlap * 0.5 * alpha;
      }
    }
  };
  return Object.assign(force, { initialize: () => {} });
}

/**
 * Settles the network once and returns every tool's mark (map units). The
 * same network and view give the same positions, to the tenth of a unit.
 * Two steps: the linked core settles on its own, then the lone tools are set
 * on a ring around the core as it actually settled, so the ring hugs it and
 * the drawing fills the view.
 */
export function settleNetwork(
  force: ForceModule,
  network: ToolNetworkModel,
  view: { width: number; height: number },
): Map<string, Circle> {
  const maxCalls = Math.max(1, ...network.nodes.map((node) => node.calls));
  const radius = new Map(
    network.nodes.map((node) => [node.id, networkRadius(node.calls, maxCalls)]),
  );
  const parts = partsOf(network);
  const partRadius = (part: string[]) =>
    Math.sqrt(part.reduce((sum, id) => sum + ((radius.get(id) ?? 0) + ROOM) ** 2, 0) * 1.15);
  const aspect = Math.min(2.4, Math.max(0.6, view.width / Math.max(1, view.height)));
  const linked = parts.filter((part) => part.length > 1);
  const lone = parts.filter((part) => part.length === 1).map((part) => part[0]!);
  const nodeById = new Map(network.nodes.map((node) => [node.id, node]));

  // The linked core: parts packed from the middle, then settled by their links.
  const homes = packParts(
    linked.map((part, index) => ({ id: String(index), r: partRadius(part) })),
    aspect,
  );
  const nodes: SimNode[] = linked.flatMap((part, index) => {
    const home = homes.get(String(index))!;
    const spread = partRadius(part) * 0.6;
    return part.map((id, slot) => {
      const distance = spread * Math.sqrt((slot + 0.5) / part.length);
      return {
        id,
        r: radius.get(id)!,
        group: nodeById.get(id)!.group,
        hx: home.x,
        hy: home.y,
        x: home.x + Math.cos(slot * GOLDEN) * distance,
        y: home.y + Math.sin(slot * GOLDEN) * distance,
      };
    });
  });
  const known = new Set(nodes.map((node) => node.id));
  const links: SimLink[] = network.links
    .filter((link) => link.backbone && known.has(link.source) && known.has(link.target))
    .map((link) => ({ source: link.source, target: link.target, strength: link.strength }));
  const maxStrength = Math.max(1e-6, ...links.map((link) => link.strength));
  const degree = new Map<string, number>();
  for (const link of links) {
    for (const end of [link.source as string, link.target as string])
      degree.set(end, (degree.get(end) ?? 0) + 1);
  }
  const colored = new Set(
    network.groups.filter((group) => group.color !== null).map((group) => group.id),
  );
  const simulation = force
    .forceSimulation<SimNode>(nodes)
    .force(
      "link",
      force
        .forceLink<SimNode, SimLink>(links)
        .id((node) => node.id)
        .distance((link) => {
          const s = link.source as SimNode;
          const t = link.target as SimNode;
          return (
            s.r +
            t.r +
            LINK_REST.max -
            (LINK_REST.max - LINK_REST.min) * (link.strength / maxStrength)
          );
        })
        .strength((link) => {
          const s = link.source as SimNode;
          const t = link.target as SimNode;
          return (
            (0.5 + 0.5 * (link.strength / maxStrength)) /
            Math.min(degree.get(s.id) ?? 1, degree.get(t.id) ?? 1)
          );
        }),
    )
    .force("charge", force.forceManyBody<SimNode>().strength(-90).distanceMax(260))
    .force(
      "collide",
      force
        .forceCollide<SimNode>((node) => node.r + MARK_GAP / 2)
        .strength(1)
        .iterations(2),
    )
    .force("x", force.forceX<SimNode>((node) => node.hx).strength(HOME_PULL))
    .force("y", force.forceY<SimNode>((node) => node.hy).strength(HOME_PULL))
    .force("groups", keepOutOfGroups(nodes, colored))
    .stop();
  // Settled before anything is drawn: manual ticks fire no events, and it never runs again.
  for (let tick = 0; tick < TICKS; tick += 1) simulation.tick();
  const core: Circle[] = nodes.map((node) => ({ x: node.x ?? 0, y: node.y ?? 0, r: node.r }));

  // The lone tools: on a ring around the settled core, shaped like the view (as wide, or as tall, as it is),
  // so the whole drawing fills it.
  const extent = networkBounds(core, []) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const middle = { x: (extent.minX + extent.maxX) / 2, y: (extent.minY + extent.maxY) / 2 };
  const shape = Math.min(aspect, 2.2);
  let a = (extent.maxX - extent.minX) / 2 + RING_GAP.x * Math.min(1, aspect);
  let b = (extent.maxY - extent.minY) / 2 + RING_GAP.y;
  if (a / b < shape) a = b * shape;
  else b = a / shape;
  const ring = ringSpots(lone.length, { a, b }).map((spot, index) => {
    const r = radius.get(lone[index]!)!;
    // A spot that comes too near a core mark (at a corner of the core) moves out along its ray until clear.
    let { x, y } = { x: middle.x + spot.x, y: middle.y + spot.y };
    const length = Math.hypot(spot.x, spot.y) || 1;
    for (
      let step = 0;
      step < 200 && core.some((mark) => Math.hypot(mark.x - x, mark.y - y) < mark.r + r + MARK_GAP);
      step += 1
    ) {
      x += (spot.x / length) * 4;
      y += (spot.y / length) * 4;
    }
    return { x, y, r };
  });

  return new Map([
    ...nodes.map((node, index): [string, Circle] => [
      node.id,
      { x: round(core[index]!.x), y: round(core[index]!.y), r: node.r },
    ]),
    ...lone.map((id, index): [string, Circle] => [
      id,
      { x: round(ring[index]!.x), y: round(ring[index]!.y), r: ring[index]!.r },
    ]),
  ]);
}

// --- shapes ----------------------------------------------------------------------

/**
 * A colored group's soft hull: a smooth closed curve around its marks, each
 * grown by `HULL_PAD`, wobbling outward a little so it reads like the map's
 * blobs. The same id and marks give the same path.
 */
export function groupHull(
  id: string,
  marks: readonly Circle[],
): { path: string; points: Point[]; bounds: Bounds } | null {
  if (marks.length === 0) return null;
  const centre = {
    x: marks.reduce((sum, mark) => sum + mark.x, 0) / marks.length,
    y: marks.reduce((sum, mark) => sum + mark.y, 0) / marks.length,
  };
  const padded = marks.map((mark) => ({ x: mark.x, y: mark.y, r: mark.r + HULL_PAD }));
  const samples = samplesFor(centre, padded);
  const hull = hullRadii(centre, padded, samples);
  const noise = wobble(id, samples);
  // A curve through samples cuts the corners between them by at most this much.
  const chord = 1 / Math.cos(Math.PI / samples);
  const points = hull.map((reach, index) => {
    const angle = (index / samples) * Math.PI * 2;
    const radius = reach * chord * (1 + HULL_WOBBLE * noise[index]!);
    return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
  });
  return {
    path: smoothClosedPath(points),
    points,
    bounds: {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    },
  };
}

export interface LinkShape {
  /** The curve, from the edge of one mark to the edge of the other (or the arrowhead's base). */
  d: string;
  /** The arrowhead at the target, for a link with an order. */
  arrow: string | null;
  /** The curve's middle, where its explanation is anchored. */
  mid: Point;
}

const fixed = (value: number) => Math.round(value * 10) / 10;

/**
 * A link as a gentle curve bowing to its left (from source to target), cut
 * back to the two marks' edges; with an order, it ends in a small arrowhead
 * that stops short of the target's mark. Null when the marks touch.
 */
export function linkShape(source: Circle, target: Circle, directed: boolean): LinkShape | null {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  if (length <= source.r + target.r + 2) return null;
  const control = {
    x: (source.x + target.x) / 2 - dy * BEND,
    y: (source.y + target.y) / 2 + dx * BEND,
  };
  // A quadratic curve leaves each end toward its control point.
  const toward = (from: Point, distance: number) => {
    const ux = control.x - from.x;
    const uy = control.y - from.y;
    const span = Math.hypot(ux, uy) || 1;
    return {
      x: from.x + (ux / span) * distance,
      y: from.y + (uy / span) * distance,
      ux: ux / span,
      uy: uy / span,
    };
  };
  const start = toward(source, source.r + 2);
  const tip = toward(target, target.r + 2.5);
  const end = directed ? toward(target, target.r + 2.5 + ARROW.length) : tip;
  const d = `M${fixed(start.x)},${fixed(start.y)}Q${fixed(control.x)},${fixed(control.y)} ${fixed(end.x)},${fixed(end.y)}`;
  // The arrowhead points along the curve's last stretch: from its base back toward the control point, reversed.
  const arrow = directed
    ? (() => {
        const px = -tip.uy;
        const py = tip.ux;
        const base = { x: tip.x + tip.ux * ARROW.length, y: tip.y + tip.uy * ARROW.length };
        return `M${fixed(tip.x)},${fixed(tip.y)}L${fixed(base.x + px * ARROW.half)},${fixed(base.y + py * ARROW.half)}L${fixed(base.x - px * ARROW.half)},${fixed(base.y - py * ARROW.half)}Z`;
      })()
    : null;
  return {
    d,
    arrow,
    mid: {
      x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
    },
  };
}

/** Everything drawn: the marks and the hulls. */
export function networkBounds(marks: Iterable<Circle>, hulls: Iterable<Bounds>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const mark of marks) {
    minX = Math.min(minX, mark.x - mark.r);
    minY = Math.min(minY, mark.y - mark.r);
    maxX = Math.max(maxX, mark.x + mark.r);
    maxY = Math.max(maxY, mark.y + mark.r);
  }
  for (const bounds of hulls) {
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * The smallest pan that brings `point` (map units) at least `margin` inside
 * the view, at the same zoom; the same transform when it already is. For a
 * keyboard reader stepping onto a tool near an edge: the drawing moves as
 * little as it must, rather than jumping to centre it.
 */
export function nudgeIntoView(
  point: Point,
  t: { x: number; y: number; k: number },
  view: { width: number; height: number },
  margin = 48,
): { x: number; y: number; k: number } {
  const axis = (offset: number, at: number, size: number) => {
    const screen = at * t.k + offset;
    const low = Math.min(margin, size / 2);
    const high = Math.max(size - margin, size / 2);
    return screen < low
      ? offset + (low - screen)
      : screen > high
        ? offset - (screen - high)
        : offset;
  };
  return { k: t.k, x: axis(t.x, point.x, view.width), y: axis(t.y, point.y, view.height) };
}

/** A box on screen by its top-left corner. */
export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const overlapArea = (a: ScreenBox, b: ScreenBox) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/**
 * Where a link's explanation goes: beside the link's middle (below, above,
 * then off each corner, then right or left of it), inside the view, and over
 * none of `avoid` (the two tools and their names) when it can be; otherwise
 * wherever it covers least.
 */
export function explanationSpot(
  anchor: Point,
  size: { width: number; height: number },
  avoid: readonly ScreenBox[],
  view: { width: number; height: number },
  gap = 14,
): { left: number; top: number } {
  const clamp = (left: number, top: number) => ({
    left: Math.min(Math.max(8, left), Math.max(8, view.width - size.width - 8)),
    top: Math.min(Math.max(8, top), Math.max(8, view.height - size.height - 8)),
  });
  const below = anchor.y + gap;
  const above = anchor.y - gap - size.height;
  const right = anchor.x + gap;
  const left = anchor.x - gap - size.width;
  const centred = anchor.x - size.width / 2;
  const candidates = [
    clamp(centred, below),
    clamp(centred, above),
    clamp(right, below),
    clamp(right, above),
    clamp(left, below),
    clamp(left, above),
    clamp(right, anchor.y - size.height / 2),
    clamp(left, anchor.y - size.height / 2),
  ];
  const cover = (spot: { left: number; top: number }) =>
    avoid.reduce((sum, box) => sum + overlapArea({ ...spot, ...size }, box), 0);
  return (
    candidates.find((spot) => cover(spot) === 0) ??
    [...candidates].sort((a, b) => cover(a) - cover(b))[0]!
  );
}

/**
 * Where an intent's card goes: beside its blob, on the side with room (right
 * when the blob sits in the left half of the view), its middle level with the
 * blob's; below or above the blob when neither side has room (a phone); always
 * inside the view.
 */
export function cardSpot(
  blob: ScreenBox,
  size: { width: number; height: number },
  view: { width: number; height: number },
  gap = 12,
): { left: number; top: number } {
  const clampLeft = (left: number) =>
    Math.min(Math.max(8, left), Math.max(8, view.width - size.width - 8));
  const clampTop = (top: number) =>
    Math.min(Math.max(8, top), Math.max(8, view.height - size.height - 8));
  const right = blob.left + blob.width + gap;
  const left = blob.left - gap - size.width;
  const middle = clampTop(blob.top + blob.height / 2 - size.height / 2);
  const roomRight = right + size.width <= view.width - 8;
  const roomLeft = left >= 8;
  const centreX = blob.left + blob.width / 2;
  if (roomRight && (centreX < view.width / 2 || !roomLeft)) return { left: right, top: middle };
  if (roomLeft) return { left, top: middle };
  const below = blob.top + blob.height + gap;
  if (below + size.height <= view.height - 8)
    return { left: clampLeft(centreX - size.width / 2), top: below };
  const above = blob.top - gap - size.height;
  if (above >= 8) return { left: clampLeft(centreX - size.width / 2), top: above };
  return {
    left: clampLeft(centreX - size.width / 2),
    top: clampTop(view.height - size.height - 8),
  };
}

/** The side of its mark a tool's name goes first. */
export type NameSide = "right" | "left" | "below" | "above";

/** The side a name facing `angle` (from `labelAngle`) takes: sideways unless it faces mostly up or down. */
export function nameSide(angle: number | null): NameSide {
  if (angle === null) return "right";
  const cos = Math.cos(angle);
  return cos > 0.35 ? "right" : cos < -0.35 ? "left" : Math.sin(angle) >= 0 ? "below" : "above";
}

/**
 * The drawing's extent with room for every tool's name on the side it faces,
 * at zoom `k`: names are a fixed size on screen, so the farther out the view
 * is, the more of the drawing they take. `gap` and `height` are on screen.
 */
export function boundsWithNames(
  bounds: Bounds,
  names: ReadonlyArray<{ mark: Circle; side: NameSide; width: number }>,
  k: number,
  gap = 5,
  height = 16,
): Bounds {
  let { minX, minY, maxX, maxY } = bounds;
  for (const { mark, side, width } of names) {
    const reach = mark.r + (gap + (side === "left" || side === "right" ? width : height)) / k;
    if (side === "right") maxX = Math.max(maxX, mark.x + reach);
    else if (side === "left") minX = Math.min(minX, mark.x - reach);
    else {
      minX = Math.min(minX, mark.x - width / 2 / k);
      maxX = Math.max(maxX, mark.x + width / 2 / k);
      if (side === "below") maxY = Math.max(maxY, mark.y + reach);
      else minY = Math.min(minY, mark.y - reach);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The way a tool's name faces first: away from the tools it is linked to (its
 * links leave on that side), or away from the drawing's middle when it has
 * none. Null when there is no way to tell.
 */
export function labelAngle(mark: Point, partners: readonly Point[], middle: Point): number | null {
  const from =
    partners.length > 0
      ? {
          x: partners.reduce((sum, point) => sum + point.x, 0) / partners.length,
          y: partners.reduce((sum, point) => sum + point.y, 0) / partners.length,
        }
      : middle;
  const dx = mark.x - from.x;
  const dy = mark.y - from.y;
  return Math.hypot(dx, dy) < 1e-6 ? null : Math.atan2(dy, dx);
}
