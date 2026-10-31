/**
 * Ribbon geometry for the tool flow map (`flow-layout.ts`): where each ribbon
 * leaves and arrives (its port), and the SVG path between. Pure; every
 * coordinate is rounded to a tenth so the paths serialize identically.
 *
 * A ribbon is a stroked cubic with horizontal tangents at both ends, drawn with
 * a butt cap, so its width reads as its weight. Ports are stacked along a
 * plate's edge in the order of the other end's height, which is what keeps two
 * ribbons from the same plate from crossing each other on the way out.
 */

export interface Point {
  x: number;
  y: number;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function f(value: number): string {
  return String(round(value));
}

/** Clear space between two ribbons stacked on one port. */
export const PORT_GAP = 1.5;

/** Height of a stack of ribbons, gaps included. */
export function stackHeight(widths: readonly number[]): number {
  if (widths.length === 0) return 0;
  return widths.reduce((sum, width) => sum + width, 0) + PORT_GAP * (widths.length - 1);
}

/** The centre of each ribbon in a stack centred on `centre`, top to bottom. */
export function stackCentred(widths: readonly number[], centre: number): number[] {
  let cursor = centre - stackHeight(widths) / 2;
  return widths.map((width) => {
    const y = cursor + width / 2;
    cursor += width + PORT_GAP;
    return round(y);
  });
}

/**
 * Ports (or whole port stacks) as close to their wanted heights as the stack
 * allows, `gap` apart: a pass down pushes overlapping ones apart, a pass up
 * pulls the stack back above `bottom`. `wanted` must be in top-to-bottom order.
 */
export function fitPorts(
  wanted: readonly number[],
  widths: readonly number[],
  top: number,
  bottom: number,
  gap: number = PORT_GAP,
): number[] {
  const y: number[] = [];
  wanted.forEach((want, i) => {
    const floor = i === 0 ? top + widths[0] / 2 : y[i - 1] + (widths[i - 1] + widths[i]) / 2 + gap;
    y.push(Math.max(want, floor));
  });
  for (let i = y.length - 1; i >= 0; i -= 1) {
    const ceiling =
      i === y.length - 1
        ? bottom - widths[i] / 2
        : y[i + 1] - (widths[i] + widths[i + 1]) / 2 - gap;
    y[i] = Math.min(y[i], ceiling);
  }
  return y.map(round);
}

/** A ribbon from one port to the next, level at both ends; straight when the ends are level. */
export function ribbonPath(start: Point, end: Point): string {
  if (Math.abs(end.y - start.y) < 0.05) return `M${f(start.x)} ${f(start.y)} H${f(end.x)}`;
  const dx = Math.max(12, (end.x - start.x) * 0.5);
  return `M${f(start.x)} ${f(start.y)} C${f(start.x + dx)} ${f(start.y)} ${f(end.x - dx)} ${f(end.y)} ${f(end.x)} ${f(end.y)}`;
}

/**
 * Two tools picked interchangeably, in the same column: a bracket off the ends
 * of both labels, its spine at `spine`, which sits before the column's
 * outlets so it never meets a ribbon.
 */
export function bracketPath(a: Point, b: Point, spine: number): string {
  const [upper, lower] = a.y <= b.y ? [a, b] : [b, a];
  const bend = Math.min(6, (lower.y - upper.y) / 2);
  return (
    `M${f(upper.x)} ${f(upper.y)} H${f(spine - bend)} Q${f(spine)} ${f(upper.y)} ${f(spine)} ${f(upper.y + bend)}` +
    ` V${f(lower.y - bend)} Q${f(spine)} ${f(lower.y)} ${f(spine - bend)} ${f(lower.y)} H${f(lower.x)}`
  );
}
