/**
 * The score charts of the Evals page and of an eval page (DESIGN.md, Data visualization): one
 * measure, a score from 0 to 100%, over the time of the runs. One line for each eval, or for each
 * scorer and their mean. A line keeps its color slot by its place in the list, so a new line never
 * repaints the others; a line past the sixth slot is not drawn, and the chart says so. Plain data:
 * the client draws it.
 */

/** The color slots of the design system (`chart-1` to `chart-6`). */
export const CHART_SLOTS = 6;

export type ChartPoint = { runId: string; at: string; value: number };

export type ChartLine = {
  key: string;
  label: string;
  /** The color slot, 0 to 5. `mean`: the mean of the other lines, drawn in the text color. */
  slot: number | "mean";
  /** In the order of time. */
  points: ChartPoint[];
};

export type ScoreChart = {
  lines: ChartLine[];
  /** The first and the last run time of the points. Null with no point. */
  start: string | null;
  end: string | null;
  /** The runs that have a point. */
  runs: number;
  /** Why the chart is not a trend yet, or what it leaves out. Null: nothing to say. */
  note: string | null;
};

export type LineInput = {
  key: string;
  label: string;
  mean?: boolean;
  points: ReadonlyArray<{ runId: string; at: string; value: number | null }>;
};

export function scoreChart(inputs: readonly LineInput[], what = "lines"): ScoreChart {
  let slot = 0;
  let hidden = 0;
  const lines: ChartLine[] = [];
  for (const input of inputs) {
    const points = input.points
      .flatMap((point) =>
        point.value === null || !Number.isFinite(point.value)
          ? []
          : [{ runId: point.runId, at: point.at, value: clamp(point.value) }],
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (input.mean) {
      lines.push({ key: input.key, label: input.label, slot: "mean", points });
      continue;
    }
    const own = slot++;
    if (own >= CHART_SLOTS) {
      hidden += 1;
      continue;
    }
    lines.push({ key: input.key, label: input.label, slot: own, points });
  }
  const times = lines.flatMap(({ points }) => points.map(({ at }) => at)).sort();
  const runs = new Set(lines.flatMap(({ points }) => points.map(({ runId }) => runId))).size;
  return {
    lines,
    start: times[0] ?? null,
    end: times.at(-1) ?? null,
    runs,
    note: noteOf(runs, hidden, what),
  };
}

/** A score as a whole percent. */
export function percent(score: number | null): string {
  return score === null ? "No score" : `${Math.round(clamp(score) * 100)}%`;
}

/** A delta in percentage points, signed. */
export function points(delta: number): string {
  const value = Math.round(delta * 100);
  if (value === 0) return "0 pts";
  return `${value > 0 ? "+" : "−"}${Math.abs(value)} pts`;
}

function noteOf(runs: number, hidden: number, what: string): string | null {
  const parts: string[] = [];
  if (runs === 1) parts.push("One run so far. A line starts with the second run.");
  if (hidden > 0) {
    parts.push(
      `The chart shows the first ${CHART_SLOTS} ${what}. ${hidden} more ${hidden === 1 ? "is" : "are"} in the table.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
