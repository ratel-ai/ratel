/**
 * Group names on the intent map: always inside their blob. A name sits at the
 * blob's visual centre (the middle of the largest circle that fits, clear of
 * the tools the group holds and of any other blob), wraps to that circle's
 * width, and ends in an ellipsis when it runs out of room. It is sized in map
 * units, so it shrinks as the map zooms out; below a readable size on screen
 * it is hidden instead of spilling out. The panel and the search always carry
 * the full name.
 */
import { type Blob, signedDistance } from "@/lib/views/intents/map/map-blobs";
import type { Bounds, Circle, Measure, Point } from "@/lib/views/intents/map/map-geometry";

/** Line height as a share of the font size. */
export const NAME_LINE_HEIGHT = 1.25;
/**
 * The smallest a name is drawn on screen as the map zooms out; below it, it is
 * hidden until a zoom. 10 px is the readable floor the codebase already holds
 * micro-labels to (`ratel/no-low-contrast-micro-labels`); static UI text keeps
 * DESIGN.md's 12 px.
 */
export const NAME_MIN_PX = 10;
/** The largest a name grows on screen as the map zooms in. */
export const NAME_MAX_PX = 16;
/** A name's size in map units, from the quietest group's to the busiest's. */
export const NAME_SIZE = { min: 12, max: 20 };
/** The fewest letters a cut word keeps before its ellipsis; with fewer the name is hidden. */
export const NAME_MIN_CHARS = 4;
/** At most this many lines; more reads as a paragraph. */
export const NAME_MAX_LINES = 3;
/** Room kept between a name and the blob's edge or a tool it holds (map units). */
export const NAME_MARGIN = 3;

const ELLIPSIS = "…";

/** A name's size in map units: larger for busier groups, so they stay named further out. */
export function nameSize(core: number, range: { min: number; max: number }): number {
  const t =
    range.max > range.min
      ? Math.min(1, Math.max(0, (core - range.min) / (range.max - range.min)))
      : 0;
  return NAME_SIZE.min + (NAME_SIZE.max - NAME_SIZE.min) * t;
}

/**
 * The font size to draw a name at, in map units, at zoom `k`: its own size,
 * capped so it grows no larger than `NAME_MAX_PX` on screen. Null when it
 * would be smaller than `NAME_MIN_PX` on screen: hidden, not shrunk past
 * reading.
 */
export function nameFontAt(size: number, k: number): number | null {
  if (!(k > 0) || size * k < NAME_MIN_PX - 1e-9) return null;
  return Math.min(size * k, NAME_MAX_PX) / k;
}

/** A name set inside a circle: its lines, and each line's width, in map units. */
export interface FittedName {
  lines: string[];
  widths: number[];
  fontSize: number;
  lineHeight: number;
}

/** The width each of `count` lines may take inside a circle of `radius`, or null when they do not fit its height. */
export function lineWidths(
  count: number,
  radius: number,
  lineHeight: number,
  inset: number,
): number[] | null {
  const widths: number[] = [];
  for (let line = 0; line < count; line += 1) {
    const middle = (line - (count - 1) / 2) * lineHeight;
    // A line's box is narrowest at its edge farthest from the centre.
    const far = Math.abs(middle) + lineHeight / 2;
    if (far >= radius) return null;
    const width = 2 * Math.sqrt(radius * radius - far * far) - 2 * inset;
    if (width <= 0) return null;
    widths.push(width);
  }
  return widths;
}

/**
 * Every word on exactly `widths.length` lines, each within its width, broken
 * where the lines fill their widths most evenly ("Find where this / function
 * is defined", not "Find where this function / is defined"); null when they
 * cannot all fit.
 */
function wrapAll(
  words: readonly string[],
  widths: readonly number[],
  measure: Measure,
): string[] | null {
  const count = widths.length;
  if (words.length < count) return null;
  let best: string[] | null = null;
  let bestFill = Infinity;
  const split = (start: number, line: number, lines: readonly string[], fill: number) => {
    if (line === count - 1) {
      const last = words.slice(start).join(" ");
      const filled = Math.max(fill, measure(last) / widths[line]!);
      if (filled <= 1 && filled < bestFill) {
        best = [...lines, last];
        bestFill = filled;
      }
      return;
    }
    for (let end = start + 1; end <= words.length - (count - 1 - line); end += 1) {
      const text = words.slice(start, end).join(" ");
      const filled = measure(text) / widths[line]!;
      // A longer line only gets wider.
      if (filled > 1) break;
      split(end, line + 1, [...lines, text], Math.max(fill, filled));
    }
  };
  split(0, 0, [], 0);
  return best;
}

/** The longest start of `word` that fits `width` with an ellipsis, keeping at least `NAME_MIN_CHARS` letters. */
function cutWord(word: string, width: number, measure: Measure): string | null {
  for (let length = word.length - 1; length >= NAME_MIN_CHARS; length -= 1) {
    const head = word.slice(0, length).replace(/[\s,;:.!?'"-]+$/u, "");
    if (head.length >= NAME_MIN_CHARS && measure(`${head}${ELLIPSIS}`) <= width)
      return `${head}${ELLIPSIS}`;
  }
  return null;
}

/** `line` ended in an ellipsis within `width`, dropping its last words until it fits; null when nothing is left. */
function closeLine(line: string, width: number, measure: Measure): string | null {
  const words = line.split(" ");
  while (words.length > 0) {
    const head = words.join(" ").replace(/[\s,;:.!?'"-]+$/u, "");
    if (head && measure(`${head}${ELLIPSIS}`) <= width) return `${head}${ELLIPSIS}`;
    words.pop();
  }
  return cutWord(line, width, measure);
}

/** As many words as fit `widths`, in order, the last line ending in an ellipsis. */
function wrapCut(
  words: readonly string[],
  widths: readonly number[],
  measure: Measure,
): string[] | null {
  const lines: string[] = [];
  let index = 0;
  for (let line = 0; line < widths.length && index < words.length; line += 1) {
    const width = widths[line]!;
    const last = line === widths.length - 1;
    let current = "";
    while (index < words.length) {
      const next = current ? `${current} ${words[index]}` : words[index]!;
      // On the last line, a word followed by more needs room for the ellipsis too.
      const shown = last && index < words.length - 1 ? `${next}${ELLIPSIS}` : next;
      if (measure(shown) > width) break;
      current = next;
      index += 1;
    }
    if (current && !(last && index < words.length)) {
      lines.push(current);
      continue;
    }
    if (current) {
      lines.push(`${current}${ELLIPSIS}`);
      return lines;
    }
    // Not even the next word fits this line: cut it, or close the line before.
    const cut = cutWord(words[index]!, width, measure);
    if (cut) {
      lines.push(cut);
      return lines;
    }
    if (lines.length === 0) return null;
    const closed = closeLine(lines[lines.length - 1]!, widths[lines.length - 1]!, measure);
    if (!closed) return null;
    lines[lines.length - 1] = closed;
    return lines;
  }
  return lines.length > 0 ? lines : null;
}

/**
 * `text` set inside a circle of `radius` at `fontSize` (both map units, with
 * `measure` at that size): the fewest lines that hold every word, else as many
 * words as the most lines that fit can hold, the last one ending in an
 * ellipsis. Lines are centred as a block and every line stays within its
 * chord. Null when not even a few letters fit.
 */
export function fitName(
  text: string,
  radius: number,
  fontSize: number,
  measure: Measure,
  maxLines = NAME_MAX_LINES,
): FittedName | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || !(radius > 0) || !(fontSize > 0)) return null;
  const lineHeight = fontSize * NAME_LINE_HEIGHT;
  const inset = fontSize * 0.2;
  const widthsFor = (count: number) => lineWidths(count, radius, lineHeight, inset);
  // A block of lines is placed by its own count, so check the lines where they will be drawn.
  const arrange = (lines: string[] | null): FittedName | null => {
    const widths = lines && lines.length > 0 ? widthsFor(lines.length) : null;
    if (!lines || !widths || lines.some((line, index) => measure(line) > widths[index]!))
      return null;
    return { lines, widths: lines.map((line) => measure(line)), fontSize, lineHeight };
  };
  let most = 0;
  for (let count = 1; count <= maxLines; count += 1) {
    const widths = widthsFor(count);
    if (!widths) break;
    most = count;
    const whole = arrange(wrapAll(words, widths, measure));
    if (whole) return whole;
  }
  for (let count = most; count >= 1; count -= 1) {
    const cut = arrange(wrapCut(words, widthsFor(count)!, measure));
    if (
      cut &&
      cut.lines.join(" ").replace(ELLIPSIS, "").replace(/\s/g, "").length >= NAME_MIN_CHARS
    )
      return cut;
  }
  return null;
}

/** True when a fitted name ends in an ellipsis: some of it was cut. */
export function isCutName(fitted: FittedName): boolean {
  return fitted.lines[fitted.lines.length - 1]!.endsWith(ELLIPSIS);
}

/**
 * `fitName`, trying smaller sizes before cutting: a name read whole at a
 * smaller size beats one cut at its own. Sizes step down by `step` (map units)
 * to `minFontSize`; the first whole fit wins, else the name at its own size,
 * cut. `measureAt` measures text at a given size.
 */
export function fitNameShrinking(
  text: string,
  radius: number,
  fontSize: number,
  minFontSize: number,
  measureAt: (fontSize: number) => Measure,
  step: number,
): FittedName | null {
  const own = fitName(text, radius, fontSize, measureAt(fontSize));
  if ((own && !isCutName(own)) || !(step > 0)) return own;
  for (let size = fontSize - step; size >= minFontSize - 1e-9; size -= step) {
    const smaller = fitName(text, radius, size, measureAt(size));
    if (smaller && !isCutName(smaller)) return smaller;
  }
  return own;
}

/** The room a name has at zoom `k` when a warning mark (`badgeRadius` on screen) sits on the outline at `badge`. */
export function nameRoom(
  name: Circle,
  badge: Point | null,
  badgeRadius: number,
  k: number,
): number {
  if (!badge) return name.r;
  const clearance = Math.hypot(badge.x - name.x, badge.y - name.y) - badgeRadius / k - NAME_MARGIN;
  return Math.min(name.r, clearance);
}

// --- the visual centre ---------------------------------------------------------

type Cell = { x: number; y: number; half: number; distance: number; potential: number };

/** A max-heap of cells by how much room they could hold. */
class CellQueue {
  private items: Cell[] = [];
  get size(): number {
    return this.items.length;
  }
  push(cell: Cell) {
    const items = this.items;
    items.push(cell);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent]!.potential >= cell.potential) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = cell;
  }
  pop(): Cell | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      // Sift the last cell down from the top, moving larger children up.
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let larger = -1;
        let best = last.potential;
        if (left < items.length && items[left]!.potential > best) {
          larger = left;
          best = items[left]!.potential;
        }
        if (right < items.length && items[right]!.potential > best) larger = right;
        if (larger < 0) break;
        items[index] = items[larger]!;
        index = larger;
      }
      items[index] = last;
    }
    return top;
  }
}

/**
 * The point in `bounds` farthest from everything `distance` measures, and how
 * far that is: the pole of inaccessibility (polylabel's search, for any
 * distance that changes no faster than the point moves). `seeds` are first
 * guesses; `precision` is in map units.
 */
export function poleOf(
  bounds: Bounds,
  distance: (point: Point) => number,
  precision = 0.5,
  seeds: readonly Point[] = [],
): Circle {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const size = Math.min(width, height);
  const cell = (x: number, y: number, half: number): Cell => {
    const value = distance({ x, y });
    return { x, y, half, distance: value, potential: value + half * Math.SQRT2 };
  };
  let best = cell((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0);
  for (const seed of seeds) {
    const candidate = cell(seed.x, seed.y, 0);
    if (candidate.distance > best.distance) best = candidate;
  }
  if (!(size > 0)) return { x: best.x, y: best.y, r: best.distance };
  const queue = new CellQueue();
  const half = size / 2;
  for (let x = bounds.minX; x < bounds.maxX; x += size) {
    for (let y = bounds.minY; y < bounds.maxY; y += size)
      queue.push(cell(x + half, y + half, half));
  }
  while (queue.size > 0) {
    const next = queue.pop()!;
    if (next.distance > best.distance) best = next;
    if (next.potential - best.distance <= precision) continue;
    const quarter = next.half / 2;
    queue.push(cell(next.x - quarter, next.y - quarter, quarter));
    queue.push(cell(next.x + quarter, next.y - quarter, quarter));
    queue.push(cell(next.x - quarter, next.y + quarter, quarter));
    queue.push(cell(next.x + quarter, next.y + quarter, quarter));
  }
  return { x: best.x, y: best.y, r: best.distance };
}

/**
 * Where a group's name sits and how much room it has: the centre of the
 * largest circle inside its blob that keeps `NAME_MARGIN` clear of the blob's
 * edge, of the tools it holds (`tools`), and of every other blob (`others`,
 * where blobs overlap). Starts from the core's centre.
 */
export function nameCircle(blob: Blob, tools: readonly Circle[], others: readonly Blob[]): Circle {
  const distance = (point: Point) => {
    let room = signedDistance(point, blob.points);
    for (const tool of tools)
      room = Math.min(room, Math.hypot(point.x - tool.x, point.y - tool.y) - tool.r);
    for (const other of others) room = Math.min(room, -signedDistance(point, other.points));
    return room;
  };
  const pole = poleOf(blob.bounds, distance, 0.5, [{ x: blob.cx, y: blob.cy }]);
  return { x: pole.x, y: pole.y, r: Math.max(0, pole.r - NAME_MARGIN) };
}
