/**
 * Pure SVG-charting math shared by the dashboard charts. No React, no DOM — just
 * geometry, so it stays trivially testable and usable from server or client.
 *
 * Curves use monotone-cubic (Fritsch–Carlson) interpolation: smooth like a
 * spline but, unlike Catmull-Rom, it never overshoots the data — a token series
 * can't dip below zero between two points. That keeps gradient area fills honest.
 */

const round = (n: number) => Math.round(n * 100) / 100;

/** SVG path (`M…C…`) of a smooth monotone curve through `pts` (x ascending). */
export function smoothPath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${round(pts[0][0])},${round(pts[0][1])}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1][0] - pts[i][0];
    dx.push(h);
    slope.push(h === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / h);
  }

  // Tangents at each point, then the Fritsch–Carlson monotonicity clamp.
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let d = `M${round(pts[0][0])},${round(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const c1x = pts[i][0] + h / 3;
    const c1y = pts[i][1] + (m[i] * h) / 3;
    const c2x = pts[i + 1][0] - h / 3;
    const c2y = pts[i + 1][1] - (m[i + 1] * h) / 3;
    d +=
      ` C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ` +
      `${round(pts[i + 1][0])},${round(pts[i + 1][1])}`;
  }
  return d;
}

/**
 * A smooth filled-area path: the curve through `pts`, then closed straight down
 * to `baseY` and back. Used for gradient area fills.
 */
export function areaPath(pts: readonly (readonly [number, number])[], baseY: number): string {
  if (pts.length === 0) return "";
  const line = smoothPath(pts);
  const last = pts[pts.length - 1][0];
  const first = pts[0][0];
  return `${line} L${round(last)},${round(baseY)} L${round(first)},${round(baseY)} Z`;
}

/** Round a maximum up to a "nice" axis ceiling (1, 2, 5 × 10ⁿ). */
export function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = 10 ** exp;
  const f = x / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

/** `count`+1 evenly spaced gridline values from 0 to niceCeil(max). */
export function niceTicks(max: number, count = 4): number[] {
  const top = niceCeil(max);
  return Array.from({ length: count + 1 }, (_, i) => (top / count) * i);
}

/** Map a series of values to [x, y] pixel points within a plot box. */
export function toPoints(
  values: readonly number[],
  opts: { width: number; height: number; padTop: number; max: number },
): [number, number][] {
  const { width, height, padTop, max } = opts;
  const innerH = height - padTop;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => padTop + innerH - (max > 0 ? (v / max) * innerH : 0);
  return values.map((v, i) => [values.length > 1 ? i * stepX : width / 2, y(v)]);
}

/** Thin a label list to ~`target` ticks, always keeping the most recent (last). */
export function labelEvery(count: number, target = 7): (i: number) => boolean {
  const step = Math.max(1, Math.ceil(count / target));
  return (i: number) => (count - 1 - i) % step === 0;
}

/**
 * Index runs of consecutive measured values in a series with gaps, so a line can
 * break where a day has no data instead of bridging it: `[1, null, 2, 3]` is
 * `[[0], [2, 3]]`.
 */
export function gapSegments(values: readonly (number | null)[]): number[][] {
  return values.reduce<number[][]>((runs, value, index) => {
    if (value === null) return runs;
    const last = runs.at(-1);
    return last && last.at(-1) === index - 1
      ? [...runs.slice(0, -1), [...last, index]]
      : [...runs, [index]];
  }, []);
}
