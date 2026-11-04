import { projectRoot } from "@/lib/console/navigation";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { createCalibrationQueries } from "@/lib/synthesis/experiments/calibration-queries";
import { createCalibrationService } from "@/lib/synthesis/experiments/calibration-service";
import type { RankingCalibrationView } from "@/lib/synthesis/experiments/calibration-types";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import { calibrationDetailPath } from "@/lib/synthesis/traces/calibration-view";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";
import {
  type DisagreementRow,
  type ExperimentKpis,
  type ExperimentRow,
  experimentKpis,
  pickExperiment,
  rowsToMeasure,
  toDisagreementRows,
  toExperimentRows,
} from "./experiments";
import { tracesWithSpans } from "./queries";
import { oneAtATime } from "./serial";
import { searchTest } from "./test-search";

/**
 * The Experiments tab: every experiment in the window with its three numbers,
 * and the open one's disagreements. Reuses the calibration service the v1
 * pages read; the deeper views (latency, the comparison funnel) stay on the
 * existing detail route, which every row links to.
 */

/** How many experiments get their numbers read; past it a row shows its count only. */
const MAX_MEASURED = 5;

/** Disagreements listed for the open experiment. */
export const DISAGREEMENTS_SHOWN = 50;

export interface ExperimentsData {
  rows: ExperimentRow[];
  selected: {
    row: ExperimentRow;
    kpis: ExperimentKpis | null;
    disagreements: DisagreementRow[];
    /** The existing detail page: latency, outcomes and the comparison funnel. */
    detailHref: string;
  } | null;
  /** Detail pages for the rows that have no comparisons of their own. */
  detailHrefs: Record<string, string>;
}

export async function loadExperiments({
  projectId,
  window,
  windowSearch,
  requested,
}: {
  projectId: string;
  window: { since: Date; until: Date };
  /** The page's window, carried to the detail pages. */
  windowSearch: string;
  requested: string | null;
}): Promise<ExperimentsData | null> {
  return loadOrFallback({
    operation: "quality_v2_experiments",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => readExperiments(projectId, window, windowSearch, requested),
  });
}

async function readExperiments(
  projectId: string,
  window: { since: Date; until: Date },
  windowSearch: string,
  requested: string | null,
): Promise<ExperimentsData> {
  const experiments = await withStatementTimeout(
    (db) => createExperimentService(createExperimentQueries(db)).listExperiments(projectId, window),
    { operation: "quality_v2_experiments_list" },
  );
  const names = experiments.map((experiment) => experiment.name);
  const summaries = await withStatementTimeout(
    (db) =>
      createCalibrationService(createCalibrationQueries(db)).resolveCalibrationSummaries(
        projectId,
        names,
        window,
      ),
    { operation: "quality_v2_experiments_census" },
  );

  const unmeasured = toExperimentRows(experiments, summaries, new Map());
  const open = pickExperiment(unmeasured, requested);
  const measured = rowsToMeasure(unmeasured, open, MAX_MEASURED);
  const views = await Promise.all(
    measured.map((row) =>
      withStatementTimeout(
        (db) =>
          createCalibrationService(oneAtATime(createCalibrationQueries(db))).getRankingCalibration(
            projectId,
            row.name,
            window,
            {
              selection: { scope: "mismatch", facets: [], match: "any" },
              limit: row.name === open?.name ? DISAGREEMENTS_SHOWN : 1,
            },
          ),
        { operation: "quality_v2_experiment_view" },
      ),
    ),
  );
  const byName = new Map<string, RankingCalibrationView>();
  measured.forEach((row, index) => {
    const view = views[index];
    if (view) byName.set(row.name, view);
  });

  const kpis = new Map([...byName].map(([name, view]) => [name, experimentKpis(view)]));
  const rows = toExperimentRows(experiments, summaries, kpis);
  const detail = (name: string) =>
    `${calibrationDetailPath(`${projectRoot(projectId)}/calibration`, name)}${windowSearch}`;
  const detailHrefs = Object.fromEntries(rows.map((row) => [row.name, detail(row.name)]));
  const selectedRow = open ? (rows.find((row) => row.name === open.name) ?? null) : null;
  if (!selectedRow) return { rows, selected: null, detailHrefs };

  const view = byName.get(selectedRow.name) ?? null;
  const disagreements = view ? await disagreementRows(projectId, selectedRow.name, view) : [];
  return {
    rows,
    selected: {
      row: selectedRow,
      kpis: kpis.get(selectedRow.name) ?? null,
      disagreements,
      detailHref: detail(selectedRow.name),
    },
    detailHrefs,
  };
}

async function disagreementRows(
  projectId: string,
  experimentName: string,
  view: RankingCalibrationView,
): Promise<DisagreementRow[]> {
  const [corpus, kept] = await Promise.all([
    loadToolCorpus(projectId),
    tracesWithSpans(
      projectId,
      view.comparisons.flatMap((row) => (row.traceId ? [row.traceId] : [])),
    ),
  ]);
  const names = new Map(corpus.map((entry) => [entry.entryId, entry.name]));
  const root = projectRoot(projectId);
  return toDisagreementRows(view.comparisons, {
    name: (id) => names.get(id) ?? id,
    traceHref: (row) =>
      row.traceId && kept.has(row.traceId)
        ? `${root}/traces/${encodeURIComponent(row.traceId)}`
        : null,
    // The experiment's ids reopen the search, rankings and all: no words in the link.
    test: (row) => searchTest({ query: row.query, selectionId: row.selectionId, experimentName }),
  });
}
