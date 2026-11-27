import type { EvalDefinition } from "./domain/eval";
import type { EvalOverviewRow } from "./history-view";
import { evalHref, experimentHref } from "./paths";

/**
 * The page model of the Evals page (decision `runs-per-eval`): one chart with a line for each eval
 * (its score in each run, over time), and a table of four columns: name, cases, scorers and the
 * baseline score. A color follows its eval, never its rank: the oldest eval has the first color.
 */

/** The colors of the chart. A seventh eval gets no generated color: the chart shows six. */
export const CHART_SLOTS = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TWO_DAYS_MS = 2 * 24 * 60 * 60_000;

export type ChartPoint = {
  experimentId: string;
  href: string;
  at: string;
  /** 0 to 1. Null: the run has no score. */
  score: number | null;
};

export type ChartSeries = {
  id: string;
  name: string;
  /** 0 to `CHART_SLOTS - 1`: the color of the eval. */
  slot: number;
  points: ChartPoint[];
};

export type ScoreChartModel = {
  series: ChartSeries[];
  /** The scored runs of all the series. */
  runs: number;
  /** Evals with a run that the chart leaves out: it draws at most `CHART_SLOTS` lines. */
  hidden: number;
};

export type EvalsTableRow = {
  evalId: string;
  href: string;
  name: string;
  cases: number;
  scorers: number;
  baselineScore: number | null;
  /** The color of the eval in the chart. Null when the chart does not draw it. */
  slot: number | null;
};

export type EvalsPage = { projectId: string; chart: ScoreChartModel; rows: EvalsTableRow[] };

export function evalsPageModel({
  projectId,
  definitions,
  overview,
}: {
  projectId: string;
  definitions: readonly Pick<EvalDefinition, "id" | "createdAt">[];
  overview: readonly EvalOverviewRow[];
}): EvalsPage {
  const age = new Map(
    [...definitions]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map(({ id }, index) => [id, index]),
  );
  const oldestFirst = [...overview].sort(
    (a, b) => (age.get(a.evalId) ?? 0) - (age.get(b.evalId) ?? 0),
  );
  const scored = oldestFirst.filter(({ series }) => series.some(({ score }) => score !== null));
  // The six evals with the newest runs; each keeps the color of its age among them.
  const drawn = new Set(
    [...scored]
      .sort((a, b) => newest(b).localeCompare(newest(a)))
      .slice(0, CHART_SLOTS)
      .map(({ evalId }) => evalId),
  );
  const slots = new Map(
    oldestFirst.filter(({ evalId }) => drawn.has(evalId)).map(({ evalId }, slot) => [evalId, slot]),
  );
  const series = oldestFirst.flatMap((row): ChartSeries[] => {
    const slot = slots.get(row.evalId);
    if (slot === undefined) return [];
    return [
      {
        id: row.evalId,
        name: row.name,
        slot,
        points: row.series.map((point) => ({
          ...point,
          href: experimentHref(projectId, point.experimentId),
        })),
      },
    ];
  });
  return {
    projectId,
    chart: {
      series,
      runs: series.reduce(
        (sum, { points }) => sum + points.filter(({ score }) => score !== null).length,
        0,
      ),
      hidden: scored.length - series.length,
    },
    rows: oldestFirst.map((row) => ({
      evalId: row.evalId,
      href: evalHref(projectId, row.evalId),
      name: row.name,
      cases: row.cases,
      scorers: row.scorers,
      baselineScore: row.baselineScore,
      slot: slots.get(row.evalId) ?? null,
    })),
  };
}

/** The rows whose name has the text, in any case. */
export function filterEvals(rows: readonly EvalsTableRow[], text: string): EvalsTableRow[] {
  const wanted = text.trim().toLowerCase();
  return wanted ? rows.filter(({ name }) => name.toLowerCase().includes(wanted)) : [...rows];
}

/** A score as a percent, with no decimal: "83%". */
export function percent(score: number | null): string {
  return score === null ? "No score" : `${Math.round(score * 100)}%`;
}

/**
 * A time on the x axis, in UTC so the server and the browser agree: "27 Nov" over a span of two
 * days or more, else "27 Nov 14:05".
 */
export function timeLabel(at: number, spanMs: number): string {
  const date = new Date(at);
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (spanMs >= TWO_DAYS_MS) return day;
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `${day} ${time}`;
}

function newest({ series }: EvalOverviewRow): string {
  return series.at(-1)?.at ?? "";
}
