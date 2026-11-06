/**
 * The Tools lens as a globe: one disc that holds every tool in its home
 * (`tool-homes`), ordered, never scattered.
 *
 * - Each home is a round region as large as its tools need. Inside it the
 *   tools sit on a sunflower spiral, the first (a task's first step, or the
 *   busiest) in the middle.
 * - Regions are packed from the middle outward in the order they come
 *   (Shared first, since it serves many tasks, then the homes with the most
 *   tools): each one takes the spot against those already placed that keeps
 *   its far edge nearest the middle, so the pack grows round.
 * - The disc is the smallest circle around the regions; tools no task runs
 *   ring it, evenly spaced from its right-hand side.
 *
 * Pure and deterministic: the same homes give the same globe every time, and
 * no two regions overlap.
 */
import type { Circle, Point } from "@/lib/views/intents/map/map-geometry";

export interface GlobeHome {
  id: string;
  /** In the order they sit: the first in the middle of its region. */
  members: readonly string[];
  /** On the ring around the disc instead of in a region (Other). */
  ring?: boolean;
}

export interface Globe {
  /** Every tool's mark (map units, the disc's centre at 0,0). */
  marks: Map<string, Circle>;
  /** Each home's region inside the disc; the ring's home has none. */
  regions: Map<string, Circle>;
  disc: Circle;
  /** The circle the ringed tools sit on; null when none do. */
  ring: Circle | null;
}

/** Between two neighbouring tools in a region, beyond their marks. */
export const TOOL_SPACING = 30;
/** Up to this many tools stand in a column; more sit on a spiral. */
export const COLUMN_MAX = 3;
/** A region's edge beyond its tools: room for its hull. */
export const REGION_PAD = 24;
/** Room above a region's tools for its name, on top of the pad, so a name always sits on its own hull. */
export const NAME_BAND = 22;
/** Between two regions, at least. */
export const REGION_GAP = 24;
/** The disc's edge beyond its regions. */
export const DISC_PAD = 18;
/** The ring beyond the disc's edge. */
export const RING_GAP = 28;
/** Between two tools on the ring, at least. */
export const RING_SPACING = 64;
/** A disc with nothing inside it still has a size, so the ring has something to go round. */
const EMPTY_DISC = 48;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Directions tried around a placed region when no pair of regions gives a spot. */
const DIRECTIONS = 48;
/** Steps of the smallest-enclosing-circle search. */
const ENCLOSE_STEPS = 400;

const round = (value: number) => Math.round(value * 10) / 10;

/** Clockwise from the top, in 0..2π: how ties between equally good spots are broken. */
function clockwise(point: Point): number {
  const angle = Math.atan2(point.y, point.x) + Math.PI / 2;
  return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

/**
 * A region's tools around its middle. Up to `COLUMN_MAX` stand in a column in
 * order, top to bottom, so a task's steps read down like its pipeline and
 * every name has the side free; more sit on a sunflower spiral (Vogel's), the
 * first at the centre. Neighbours keep `TOOL_SPACING` clear of each other's
 * marks. The tools are centred on the box they fill, and the radius is what
 * the region needs, its pad included.
 */
export function arrangeRegion(
  members: readonly string[],
  radius: ReadonlyMap<string, number>,
): { points: Map<string, Point>; r: number } {
  const sizes = members.map((id) => radius.get(id) ?? 0);
  const largest = Math.max(0, ...sizes);
  const step = 2 * largest + TOOL_SPACING;
  let below = 0;
  const raw =
    members.length <= COLUMN_MAX
      ? members.map((_, index) => {
          if (index > 0) below += sizes[index - 1]! + sizes[index]! + TOOL_SPACING;
          return { x: 0, y: below };
        })
      : members.map((_, index) => {
          // Turned so the second tool sits straight below the first.
          const angle = index * GOLDEN + Math.PI / 2 - GOLDEN;
          return index === 0
            ? { x: 0, y: 0 }
            : {
                x: step * Math.sqrt(index) * Math.cos(angle),
                y: step * Math.sqrt(index) * Math.sin(angle),
              };
        });
  const minX = Math.min(...raw.map((point, index) => point.x - sizes[index]!));
  const maxX = Math.max(...raw.map((point, index) => point.x + sizes[index]!));
  // The name's band sits above the topmost tool, inside the region.
  const minY = Math.min(...raw.map((point, index) => point.y - sizes[index]!)) - NAME_BAND;
  const maxY = Math.max(...raw.map((point, index) => point.y + sizes[index]!));
  const cx = members.length > 0 ? (minX + maxX) / 2 : 0;
  const cy = members.length > 0 ? (minY + maxY) / 2 : 0;
  const points = new Map(
    members.map((id, index) => [id, { x: raw[index]!.x - cx, y: raw[index]!.y - cy }]),
  );
  const reach = Math.max(
    0,
    ...members.map((id, index) => Math.hypot(points.get(id)!.x, points.get(id)!.y) + sizes[index]!),
    // The band's two top corners, a hull's width apart.
    ...(members.length > 0 ? [Math.hypot((maxX - minX) / 2, minY - cy)] : []),
  );
  return { points, r: reach + REGION_PAD };
}

/** Where two circles around `a` and `b` (radii `ra`, `rb`) cross: none, or two points. */
function crossings(a: Point, ra: number, b: Point, rb: number): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || distance > ra + rb || distance < Math.abs(ra - rb)) return [];
  const along = (ra * ra - rb * rb + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, ra * ra - along * along));
  const mx = a.x + (dx * along) / distance;
  const my = a.y + (dy * along) / distance;
  return [
    { x: mx - (dy * height) / distance, y: my + (dx * height) / distance },
    { x: mx + (dy * height) / distance, y: my - (dx * height) / distance },
  ];
}

/**
 * Circles packed in the order given: the first at the middle, each next one
 * touching (with `gap`) two placed circles, or one, at the free spot whose far
 * edge is nearest the middle; ties go to the spot first clockwise from the top.
 */
export function packRegions(
  circles: ReadonlyArray<{ id: string; r: number }>,
  gap: number = REGION_GAP,
): Map<string, Point> {
  const placed: Circle[] = [];
  const out = new Map<string, Point>();
  for (const circle of circles) {
    let spot: Point = { x: 0, y: 0 };
    if (placed.length > 0) {
      const candidates: Point[] = [];
      for (let i = 0; i < placed.length; i += 1) {
        const a = placed[i]!;
        for (let step = 0; step < DIRECTIONS; step += 1) {
          const angle = -Math.PI / 2 + (step / DIRECTIONS) * Math.PI * 2;
          candidates.push({
            x: a.x + Math.cos(angle) * (a.r + circle.r + gap),
            y: a.y + Math.sin(angle) * (a.r + circle.r + gap),
          });
        }
        for (let j = i + 1; j < placed.length; j += 1) {
          const b = placed[j]!;
          candidates.push(...crossings(a, a.r + circle.r + gap, b, b.r + circle.r + gap));
        }
      }
      const free = candidates.filter((point) =>
        placed.every(
          (other) =>
            Math.hypot(other.x - point.x, other.y - point.y) >= other.r + circle.r + gap - 1e-6,
        ),
      );
      let best: { point: Point; reach: number; angle: number } | null = null;
      for (const point of free) {
        const reach = Math.round((Math.hypot(point.x, point.y) + circle.r) * 1000) / 1000;
        const angle = clockwise(point);
        if (!best || reach < best.reach || (reach === best.reach && angle < best.angle))
          best = { point, reach, angle };
      }
      spot = best?.point ?? spot;
    }
    placed.push({ x: spot.x, y: spot.y, r: circle.r });
    out.set(circle.id, spot);
  }
  return out;
}

/**
 * Close to the smallest circle around `circles`: from their middle, step
 * toward the one that reaches farthest by a shrinking share (Bădoiu and
 * Clarkson's walk), then take the reach from there.
 */
export function encloseCircles(circles: readonly Circle[]): Circle {
  if (circles.length === 0) return { x: 0, y: 0, r: 0 };
  let x = circles.reduce((sum, circle) => sum + circle.x, 0) / circles.length;
  let y = circles.reduce((sum, circle) => sum + circle.y, 0) / circles.length;
  const farthest = () => {
    let best = circles[0]!;
    let reach = -Infinity;
    for (const circle of circles) {
      const value = Math.hypot(circle.x - x, circle.y - y) + circle.r;
      if (value > reach) {
        reach = value;
        best = circle;
      }
    }
    return { circle: best, reach };
  };
  for (let step = 1; step <= ENCLOSE_STEPS; step += 1) {
    const { circle } = farthest();
    const distance = Math.hypot(circle.x - x, circle.y - y);
    if (distance === 0) break;
    // Toward the far circle's far edge, by a share that shrinks each step.
    const ux = (circle.x - x) / distance;
    const uy = (circle.y - y) / distance;
    const edge = { x: circle.x + ux * circle.r, y: circle.y + uy * circle.r };
    x += (edge.x - x) / (step + 1);
    y += (edge.y - y) / (step + 1);
  }
  return { x, y, r: farthest().reach };
}

/** Spots for `count` tools on a circle of `radius`, evenly spaced from its right-hand side, clockwise on screen. */
export function ringSpots(count: number, radius: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}

/**
 * The globe for `homes` (in the order they are packed) and each tool's mark
 * radius. Every tool of a home lands in that home's region, or on the ring.
 */
export function globeLayout(
  homes: readonly GlobeHome[],
  radius: ReadonlyMap<string, number>,
): Globe {
  const inside = homes.filter((home) => !home.ring && home.members.length > 0);
  const ringed = homes.filter((home) => home.ring).flatMap((home) => home.members);
  const arranged = inside.map((home) => ({ home, ...arrangeRegion(home.members, radius) }));
  const centres = packRegions(arranged.map(({ home, r }) => ({ id: home.id, r })));
  const regionsRaw = arranged.map(({ home, r }) => ({ id: home.id, ...centres.get(home.id)!, r }));
  const enclosing = encloseCircles(regionsRaw);
  const shift = { x: enclosing.x, y: enclosing.y };
  const disc: Circle = {
    x: 0,
    y: 0,
    r: round(regionsRaw.length > 0 ? enclosing.r + DISC_PAD : EMPTY_DISC),
  };

  const marks = new Map<string, Circle>();
  const regions = new Map<string, Circle>();
  for (const { home, points, r } of arranged) {
    const centre = centres.get(home.id)!;
    regions.set(home.id, {
      x: round(centre.x - shift.x),
      y: round(centre.y - shift.y),
      r: round(r),
    });
    for (const id of home.members) {
      const point = points.get(id)!;
      marks.set(id, {
        x: round(centre.x - shift.x + point.x),
        y: round(centre.y - shift.y + point.y),
        r: radius.get(id) ?? 0,
      });
    }
  }

  let ring: Circle | null = null;
  if (ringed.length > 0) {
    const largest = Math.max(0, ...ringed.map((id) => radius.get(id) ?? 0));
    const r = Math.max(disc.r + RING_GAP + largest, (ringed.length * RING_SPACING) / (Math.PI * 2));
    ring = { x: 0, y: 0, r: round(r) };
    ringSpots(ringed.length, r).forEach((spot, index) => {
      const id = ringed[index]!;
      marks.set(id, { x: round(spot.x), y: round(spot.y), r: radius.get(id) ?? 0 });
    });
  }
  return { marks, regions, disc, ring };
}
