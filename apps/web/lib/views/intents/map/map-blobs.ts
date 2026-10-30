/**
 * Ask groups drawn as blobs: a smooth closed curve around a group's core and
 * the tools it holds, wobbling outward by a few percent so the groups read as
 * organic shapes rather than stamped circles. The wobble is seeded by the
 * group's id, so a group keeps its shape on every render and every re-layout.
 * Pure functions of plain points, so the rules are tested and the map stays a
 * thin renderer.
 */
import type { Bounds, Circle, Point } from "@/lib/views/intents/map/map-geometry";

/** Points around an outline: enough for a smooth curve at the largest zoom. */
export const BLOB_SAMPLES = 64;
/** The most an outline takes, for a disc held far out. */
const MAX_SAMPLES = 256;
/** How far an outline wanders outward, as a share of its radius. */
export const BLOB_WOBBLE = 0.07;
/** Directions the hull is measured in, per sample: about one per degree, exact to a hair. */
const HULL_DIRECTIONS_PER_SAMPLE = 6;

export interface Blob {
  /** The centre the outline is measured from (the group's core). */
  cx: number;
  cy: number;
  /** The outline's distance from the centre at evenly spaced angles (`BLOB_SAMPLES` or more), from 0 and turning with screen y (down). */
  radii: number[];
  /** The outline as a polygon through those samples (map units). */
  points: Point[];
  /** The same outline as a smooth closed SVG path. */
  path: string;
  bounds: Bounds;
}

/** FNV-1a: a stable 32-bit number for an id. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32: a small, fast generator in 0..1, the same sequence for the same seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A group's wobble: smooth periodic noise in 0..1 at each sample angle, a few
 * low harmonics with seeded weights and phases. The same id always gives the
 * same wobble; its lowest point is 0 and its highest 1.
 */
export function wobble(id: string, samples: number = BLOB_SAMPLES): number[] {
  const random = seededRandom(hashId(id));
  const harmonics = [2, 3, 4, 5].map((order) => ({
    order,
    weight: (0.55 + 0.45 * random()) / order,
    phase: random() * Math.PI * 2,
  }));
  const raw = Array.from({ length: samples }, (_, index) => {
    const angle = (index / samples) * Math.PI * 2;
    return harmonics.reduce(
      (sum, harmonic) => sum + harmonic.weight * Math.cos(harmonic.order * angle + harmonic.phase),
      0,
    );
  });
  const low = Math.min(...raw);
  const span = Math.max(...raw) - low || 1;
  return raw.map((value) => (value - low) / span);
}

/**
 * How far the convex hull of `discs` (map positions) reaches from `centre` at
 * each sample angle. Read through the hull's support, about one direction per
 * degree, which can only overstate the hull, never cut into it. The centre
 * must lie inside one of the discs.
 */
export function hullRadii(
  centre: Point,
  discs: readonly Circle[],
  samples: number = BLOB_SAMPLES,
): number[] {
  const directions = samples * HULL_DIRECTIONS_PER_SAMPLE;
  const cosines = Array.from({ length: directions }, (_, index) =>
    Math.cos((index / directions) * Math.PI * 2),
  );
  const support = cosines.map((_, index) => {
    const ux = cosines[index]!;
    const uy = cosines[(index - directions / 4 + directions) % directions]!;
    return Math.max(
      ...discs.map((disc) => (disc.x - centre.x) * ux + (disc.y - centre.y) * uy + disc.r),
    );
  });
  const quarter = directions / 4;
  return Array.from({ length: samples }, (_, sample) => {
    const facingIndex = sample * HULL_DIRECTIONS_PER_SAMPLE;
    let radius = Infinity;
    // Only directions within a quarter turn of the ray bound it.
    for (let offset = 1 - quarter; offset < quarter; offset += 1) {
      const direction = (facingIndex + offset + directions) % directions;
      const facing = cosines[(offset + directions) % directions]!;
      radius = Math.min(radius, support[direction]! / facing);
    }
    return radius;
  });
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The cubic Bézier controls of a closed Catmull-Rom curve through `points`, one pair per segment. */
function controls(points: readonly Point[]): Array<[Point, Point]> {
  const count = points.length;
  return points.map((point, index) => {
    const previous = points[(index - 1 + count) % count]!;
    const next = points[(index + 1) % count]!;
    const after = points[(index + 2) % count]!;
    return [
      { x: point.x + (next.x - previous.x) / 6, y: point.y + (next.y - previous.y) / 6 },
      { x: next.x - (after.x - point.x) / 6, y: next.y - (after.y - point.y) / 6 },
    ];
  });
}

/** A smooth closed SVG path through `points` (a Catmull-Rom curve as cubic Béziers). */
export function smoothClosedPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const pairs = controls(points);
  const segments = points.map((_, index) => {
    const [first, second] = pairs[index]!;
    const end = points[(index + 1) % points.length]!;
    return `C${round(first.x)},${round(first.y)} ${round(second.x)},${round(second.y)} ${round(end.x)},${round(end.y)}`;
  });
  return `M${round(points[0]!.x)},${round(points[0]!.y)}${segments.join("")}Z`;
}

/** The smooth curve through `points` itself, `steps` points per segment: what the path draws. */
export function smoothClosedCurve(points: readonly Point[], steps = 8): Point[] {
  const pairs = controls(points);
  const out: Point[] = [];
  points.forEach((start, index) => {
    const [first, second] = pairs[index]!;
    const end = points[(index + 1) % points.length]!;
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      out.push({
        x: a * start.x + b * first.x + c * second.x + d * end.x,
        y: a * start.y + b * first.y + c * second.y + d * end.y,
      });
    }
  });
  return out;
}

/**
 * Samples enough that each disc, as seen from the centre, spans several of
 * them: a small disc held far out would otherwise fall between two and have
 * its tip cut off.
 */
export function samplesFor(centre: Point, discs: readonly Circle[]): number {
  let narrowest = Math.PI;
  for (const disc of discs) {
    const distance = Math.hypot(disc.x - centre.x, disc.y - centre.y);
    if (distance > disc.r) narrowest = Math.min(narrowest, Math.asin(disc.r / distance));
  }
  const needed = Math.ceil((Math.PI * 2 * 1.5) / narrowest);
  return Math.min(MAX_SAMPLES, Math.max(BLOB_SAMPLES, Math.ceil(needed / 8) * 8));
}

/**
 * How far the blob reaches from `centre` at each sample: around `body` (a disc
 * holding the centre) and each other disc, every one joined to the body by its
 * own hull. Two discs on different sides are not bridged, so a group holding
 * tools toward several neighbours bulges toward each, not over the space
 * between them.
 */
function heldRadii(
  centre: Point,
  body: Circle,
  others: readonly Circle[],
  samples: number,
): number[] {
  const radii = hullRadii(centre, [body], samples);
  for (const disc of others) {
    // A disc inside the body changes nothing.
    if (Math.hypot(disc.x - body.x, disc.y - body.y) + disc.r <= body.r) continue;
    hullRadii(centre, [body, disc], samples).forEach((radius, index) => {
      if (radius > radii[index]!) radii[index] = radius;
    });
  }
  return radii;
}

/**
 * A group's blob: a smooth closed curve around its padded discs (`discs[0]` is
 * its round body, which holds the centre; the rest are the tools it holds,
 * each already padded and each joined to the body by its own hull), wobbling
 * outward by up to `BLOB_WOBBLE` of the radius. The wobble only ever adds, so
 * everything the discs cover stays inside; the same id and discs give the
 * same path.
 */
export function blobOutline(id: string, centre: Point, discs: readonly Circle[]): Blob {
  const samples = samplesFor(centre, discs);
  const hull =
    discs.length > 0
      ? heldRadii(centre, discs[0]!, discs.slice(1), samples)
      : new Array<number>(samples).fill(0);
  const noise = wobble(id, samples);
  // A curve through samples cuts the corners between them by at most this much.
  const chord = 1 / Math.cos(Math.PI / samples);
  const radii = hull.map(
    (radius, index) => radius * chord * (1 + BLOB_WOBBLE * noise[index]!) + 0.5,
  );
  const points = radii.map((radius, index) => {
    const angle = (index / samples) * Math.PI * 2;
    return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
  });
  return {
    cx: centre.x,
    cy: centre.y,
    radii,
    points,
    path: smoothClosedPath(points),
    bounds: boundsOfPoints(points),
  };
}

/** Where the outline crosses the ray from the blob's centre at `angle` (radians, screen y down). */
export function blobPointAt(blob: Pick<Blob, "cx" | "cy" | "radii">, angle: number): Point {
  const samples = blob.radii.length;
  const turn = (((angle / (Math.PI * 2)) % 1) + 1) % 1;
  const position = turn * samples;
  const index = Math.floor(position) % samples;
  const t = position - Math.floor(position);
  const radius = blob.radii[index]! * (1 - t) + blob.radii[(index + 1) % samples]! * t;
  return { x: blob.cx + Math.cos(angle) * radius, y: blob.cy + Math.sin(angle) * radius };
}

/** The farthest the outline reaches from its centre. */
export function blobReach(blob: Pick<Blob, "radii">): number {
  return Math.max(...blob.radii);
}

// --- polygons ----------------------------------------------------------------------

/** Whether `point` lies inside `polygon` (even-odd rule). */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** The squared distance from `point` to the segment from `a` to `b`. */
function segmentDistance2(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
      : 0;
  const ex = point.x - (a.x + t * dx);
  const ey = point.y - (a.y + t * dy);
  return ex * ex + ey * ey;
}

/** How far `point` is from the polygon's edge: positive inside, negative outside. */
export function signedDistance(point: Point, polygon: readonly Point[]): number {
  let nearest = Infinity;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const distance = segmentDistance2(point, polygon[previous]!, polygon[index]!);
    if (distance < nearest) nearest = distance;
  }
  const value = Math.sqrt(nearest);
  return pointInPolygon(point, polygon) ? value : -value;
}

/** Whether two boxes overlap, each grown by `pad`. */
export function boundsMeet(a: Bounds, b: Bounds, pad = 0): boolean {
  return (
    a.minX - pad <= b.maxX &&
    b.minX - pad <= a.maxX &&
    a.minY - pad <= b.maxY &&
    b.minY - pad <= a.maxY
  );
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function boundsOfPoints(points: readonly Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Whether two outlines overlap: one holds a point of the other, or their edges cross. */
export function polygonsMeet(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (!boundsMeet(boundsOfPoints(a), boundsOfPoints(b))) return false;
  if (pointInPolygon(a[0]!, b) || pointInPolygon(b[0]!, a)) return true;
  for (let i = 0, ip = a.length - 1; i < a.length; ip = i, i += 1) {
    for (let j = 0, jp = b.length - 1; j < b.length; jp = j, j += 1) {
      if (segmentsCross(a[ip]!, a[i]!, b[jp]!, b[j]!)) return true;
    }
  }
  return false;
}
