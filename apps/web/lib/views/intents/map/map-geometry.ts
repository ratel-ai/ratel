/**
 * Geometry for the intent map shared by its parts: points and circles, text
 * widths, which tool names fit at the current zoom and where, and the
 * transform that fits the drawing to the view. Pure functions of plain points,
 * so the client map stays a thin renderer and the rules are tested. Blobs live
 * in `map-blobs`, names in `map-names`, and where everything sits in
 * `map-layout`.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Circle extends Point {
  r: number;
}

// --- labels ----------------------------------------------------------------------

/** How wide a string renders. The map measures with the real font; `estimateMeasure` stands in. */
export type Measure = (text: string) => number;

/** Rough rendered width of a label at `fontSize`. */
export function labelWidth(text: string, fontSize: number, mono = false): number {
  return text.length * fontSize * (mono ? 0.62 : 0.56);
}

export function estimateMeasure(fontSize: number, mono = false): Measure {
  return (text) => labelWidth(text, fontSize, mono);
}

/**
 * The ids labelled at rest: the busiest `share` of items by weight, at least
 * `min` of them. Everything else is labelled on zoom or hover.
 */
export function restingLabelIds(
  items: ReadonlyArray<{ id: string; weight: number }>,
  share = 0.15,
  min = 3,
): Set<string> {
  const count = Math.max(min, Math.ceil(items.length * share));
  return new Set(
    [...items]
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
      .slice(0, count)
      .map((item) => item.id),
  );
}

/** One place a label may go, as a box centred on (`x`, `y`) in screen space. */
export interface LabelCandidate {
  id: string;
  /** Circles this one spot may overlap, when they differ from its label's. */
  owners?: readonly string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A label with the places it may go, best first. */
export interface LabelChoice<Spot extends LabelCandidate = LabelCandidate> {
  id: string;
  spots: readonly Spot[];
  /** The circles it names or sits beside, which it may overlap. */
  owners?: readonly string[];
  /** When set, only these circles block it (a lit label may sit over dimmed ones). */
  blockers?: ReadonlySet<string>;
  /**
   * Named however crowded the view: when every spot runs into a circle, it
   * takes the first one clear of other labels and of every hard obstacle,
   * over soft ones (the busiest groups at rest, the node being pointed at).
   */
  fallback?: boolean;
}

/** An obstacle for labels. A soft one (a circle, a bead) may sit under a fallback label; a hard one (a badge) never. */
export type LabelObstacle = Circle & { id: string; soft?: boolean };

function boxHitsCircle(box: LabelCandidate, circle: Circle, pad: number): boolean {
  const left = box.x - box.width / 2;
  const top = box.y - box.height / 2;
  const nearestX = Math.max(left, Math.min(circle.x, left + box.width));
  const nearestY = Math.max(top, Math.min(circle.y, top + box.height));
  return Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.r + pad;
}

/**
 * Greedy placement with alternatives: each label, in priority order, takes
 * the first of its spots that stays in view, clears every label already
 * placed (and every box in `taken`, text drawn elsewhere), and clears every
 * circle but its owners'. A label with no free spot is left off (it shows on
 * hover, or once a zoom makes room), unless it is a fallback label, which then
 * settles for a spot over a soft circle. Zooming in spreads the drawing, so
 * more of the same list fits: that is the whole of the semantic zoom.
 */
export function placeLabelChoices<Spot extends LabelCandidate>(
  choices: ReadonlyArray<LabelChoice<Spot>>,
  circles: ReadonlyArray<LabelObstacle>,
  view: { width: number; height: number } | null = null,
  gap = 3,
  taken: readonly LabelCandidate[] = [],
): Map<string, Spot> {
  const kept: LabelCandidate[] = [...taken];
  const out = new Map<string, Spot>();
  const inView = (spot: Spot) => {
    const left = spot.x - spot.width / 2;
    const top = spot.y - spot.height / 2;
    return (
      !view ||
      (left >= 2 &&
        top >= 2 &&
        left + spot.width <= view.width - 2 &&
        top + spot.height <= view.height - 2)
    );
  };
  const clearOfLabels = (spot: Spot) =>
    kept.every(
      (other) =>
        Math.abs(other.x - spot.x) * 2 >= other.width + spot.width + gap * 2 ||
        Math.abs(other.y - spot.y) * 2 >= other.height + spot.height + gap * 2,
    );
  for (const choice of choices) {
    const clearOf = (spot: Spot, hardOnly: boolean) => {
      const owners = spot.owners ?? choice.owners;
      return !circles.some(
        (circle) =>
          !(hardOnly && circle.soft) &&
          !owners?.includes(circle.id) &&
          (!choice.blockers || choice.blockers.has(circle.id)) &&
          boxHitsCircle(spot, circle, 1),
      );
    };
    const open = choice.spots.filter((spot) => inView(spot) && clearOfLabels(spot));
    const spot =
      open.find((candidate) => clearOf(candidate, false)) ??
      (choice.fallback ? open.find((candidate) => clearOf(candidate, true)) : undefined);
    if (!spot) continue;
    kept.push(spot);
    out.set(choice.id, spot);
  }
  return out;
}

// --- view --------------------------------------------------------------------------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

/** The zoom that shows `bounds` whole inside a `width` by `height` view, centred. */
export function fitTransform(
  bounds: Bounds,
  width: number,
  height: number,
  padding = 32,
  scale: { min: number; max: number } = { min: 0.25, max: 2 },
): ViewTransform {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const k = Math.min(
    scale.max,
    Math.max(scale.min, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
  );
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}

/** How much of the view a drawing larger than it always fills, on each axis. */
export const KEEP_IN_VIEW = 0.35;
/** How far past the fitted view the reader may zoom out. */
const ZOOM_OUT_ROOM = 0.8;
/** Never smaller than this, whatever the drawing. */
const ZOOM_HARD_FLOOR = 0.05;

/**
 * The smallest zoom allowed for a drawing that fits the view at `fitK`: a
 * little past the fitted view, so the reader can step back, never so far that
 * the drawing shrinks to a speck. The fitted view itself is always reachable.
 */
export function zoomFloor(fitK: number): number {
  return Math.min(fitK, Math.max(ZOOM_HARD_FLOOR, Math.round(fitK * ZOOM_OUT_ROOM * 1000) / 1000));
}

/**
 * Pan bounds, applied to every drag, pinch and wheel: a drawing that fits the
 * view stays whole inside it (it can be nudged, never pushed out), and a
 * drawing larger than the view always fills at least `keep` of it on each
 * axis, so the reader can never pan into empty space and lose it.
 */
export function constrainView(
  t: ViewTransform,
  view: { width: number; height: number },
  bounds: Bounds,
  keep = KEEP_IN_VIEW,
): ViewTransform {
  const axis = (offset: number, min: number, max: number, size: number) => {
    const start = min * t.k + offset;
    const end = max * t.k + offset;
    const need = Math.min(end - start, size * keep);
    if (end < need) return offset + (need - end);
    if (start > size - need) return offset - (start - (size - need));
    return offset;
  };
  return {
    k: t.k,
    x: axis(t.x, bounds.minX, bounds.maxX, view.width),
    y: axis(t.y, bounds.minY, bounds.maxY, view.height),
  };
}

/** The transform that puts `point` in the middle of the view at zoom `k`. */
export function centreOn(point: Point, width: number, height: number, k: number): ViewTransform {
  return { k, x: width / 2 - point.x * k, y: height / 2 - point.y * k };
}

/** Ease-out from one transform to another at `t` in 0..1, for the fly-to. */
export function lerpTransform(from: ViewTransform, to: ViewTransform, t: number): ViewTransform {
  const eased = 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    k: from.k + (to.k - from.k) * eased,
  };
}

/** Radius for a weight on a square-root scale, so area tracks the number. */
export function radiusFor(
  weight: number,
  max: number,
  range: { min: number; max: number },
): number {
  if (!(max > 0) || !(weight > 0)) return range.min;
  return range.min + (range.max - range.min) * Math.sqrt(Math.min(1, weight / max));
}
