import { datasetOf, type EvalDefinition } from "./domain/eval";
import type { EvalOverviewRow } from "./history-view";
import { evalHref } from "./paths";
import type { DatasetSummary } from "./ports/dataset-store";
import { type ScoreChart, scoreChart } from "./score-chart";

/**
 * The Evals page (decision `runs-per-eval`): how each eval scores over its runs, as one chart with
 * a line for each eval, then a table with four columns: name, cases, scorers, baseline score.
 * Creating and running are one click away, in dialogs. Plain data.
 */

export type EvalListRow = {
  evalId: string;
  name: string;
  href: string;
  /** "12" for a fixed dataset, "Up to 50 (query)" for a query kind. */
  cases: string;
  scorers: number;
  baselineScore: number | null;
  /** The color slot of its line. Null when the chart does not draw it. */
  slot: number | null;
};

export type EvalsPageModel = {
  projectId: string;
  chart: ScoreChart;
  rows: EvalListRow[];
};

export function evalsPageModel({
  projectId,
  overview,
  evals,
  datasets,
}: {
  projectId: string;
  /** In the order of the evals: the oldest first, so a line keeps its color. */
  overview: readonly EvalOverviewRow[];
  evals: readonly EvalDefinition[];
  datasets: readonly DatasetSummary[];
}): EvalsPageModel {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const definitions = new Map(evals.map((definition) => [definition.id, definition]));
  const chart = scoreChart(
    overview.map((row) => ({
      key: row.evalId,
      label: row.name,
      points: row.series.map(({ experimentId, at, score }) => ({
        runId: experimentId,
        at,
        value: score,
      })),
    })),
    "evals",
  );
  const slots = new Map(
    chart.lines.flatMap((line) => (typeof line.slot === "number" ? [[line.key, line.slot]] : [])),
  );
  return {
    projectId,
    chart,
    rows: overview.map((row) => {
      const definition = definitions.get(row.evalId);
      const dataset = definition ? byId.get(datasetOf(definition)) : undefined;
      return {
        evalId: row.evalId,
        name: row.name,
        href: evalHref(projectId, row.evalId),
        cases:
          dataset && dataset.query.kind !== "fixed"
            ? `Up to ${dataset.query.limit} (query)`
            : String(row.cases),
        scorers: row.scorers,
        baselineScore: row.baselineScore,
        slot: slots.get(row.evalId) ?? null,
      };
    }),
  };
}

/** The rows whose name has the text, any case. */
export function filterEvals(rows: readonly EvalListRow[], text: string): EvalListRow[] {
  const wanted = text.trim().toLowerCase();
  return wanted === "" ? [...rows] : rows.filter(({ name }) => name.toLowerCase().includes(wanted));
}
