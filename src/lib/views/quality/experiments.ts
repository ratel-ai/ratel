import type {
  ExperimentCalibrationSummary,
  RankingCalibrationView,
  RankingComparisonRowView,
} from "@/lib/synthesis/experiments/calibration-types";
import { diffRankings } from "@/lib/synthesis/experiments/ranking";
import type { ExperimentSummary } from "@/lib/synthesis/experiments/types";
import type { ToolRef } from "./miss-rows";
import type { SearchTest } from "./test-search";

/**
 * Experiments (calibrations) in plain words. An experiment runs a second
 * ranking beside the one your agent is shown; the current variant is the list
 * the agent saw and the comparison variant is the one ranked beside it. Three
 * numbers say how close they are: the same first pick, the same order, and how
 * many searches were compared at all.
 */

export interface ExperimentKpis {
  /** Share of comparisons where both variants put the same tool first. */
  firstPick: number | null;
  /** Share where both lists came back in the same order. */
  sameOrder: number | null;
  /** Share of eligible searches that were actually compared. */
  coverage: number | null;
  comparisons: number;
  disagreements: number;
  /** The variant the agent was shown, in the busiest direction. */
  current: string | null;
  comparison: string | null;
}

/** Weighted by comparisons across directions, so a swapped minority cannot outvote the main one. */
export function experimentKpis(view: RankingCalibrationView): ExperimentKpis {
  const main =
    [...view.pairs].sort((left, right) => right.comparisonCount - left.comparisonCount)[0] ?? null;
  const weighted = (
    pick: (pair: RankingCalibrationView["pairs"][number]) => number | null,
  ): number | null => {
    let total = 0;
    let sum = 0;
    for (const pair of view.pairs) {
      const value = pick(pair);
      if (value === null || pair.comparisonCount <= 0) continue;
      total += pair.comparisonCount;
      sum += value * pair.comparisonCount;
    }
    return total === 0 ? null : sum / total;
  };
  return {
    firstPick: weighted((pair) => pair.top1Rate),
    sameOrder: weighted((pair) => pair.exactOrderRate),
    coverage: main
      ? (view.lifecycle.find((arm) => arm.arm === main.shadowArm)?.shadowCoverage ?? null)
      : null,
    comparisons: view.totalComparisonCount,
    disagreements: view.mismatchCount,
    current: main?.servedArm ?? null,
    comparison: main?.shadowArm ?? null,
  };
}

export interface ExperimentRow {
  name: string;
  /** `ranking` when the experiment recorded comparisons; `other` for a plain A/B. */
  kind: "ranking" | "other";
  comparisons: number;
  runs: number;
  kpis: ExperimentKpis | null;
  /** ISO time it was last seen. */
  lastSeen: string;
}

/** Busiest first among ranking experiments, then the rest by recency. */
export function toExperimentRows(
  experiments: readonly ExperimentSummary[],
  summaries: ReadonlyMap<string, ExperimentCalibrationSummary>,
  kpis: ReadonlyMap<string, ExperimentKpis>,
): ExperimentRow[] {
  return experiments
    .map((experiment): ExperimentRow => {
      const summary = summaries.get(experiment.name);
      const ranking = summary?.kind === "ranking-shadow";
      return {
        name: experiment.name,
        kind: ranking ? "ranking" : "other",
        comparisons: summary?.comparisonCount ?? 0,
        runs: experiment.traceCount,
        kpis: kpis.get(experiment.name) ?? null,
        lastSeen: experiment.lastSeenAt.toISOString(),
      };
    })
    .sort(
      (left, right) =>
        Number(right.kind === "ranking") - Number(left.kind === "ranking") ||
        right.comparisons - left.comparisons ||
        right.lastSeen.localeCompare(left.lastSeen) ||
        left.name.localeCompare(right.name),
    );
}

/** The experiment a page opens on: the one asked for, else the busiest that compared rankings. */
export function pickExperiment(
  rows: readonly ExperimentRow[],
  requested: string | null,
): ExperimentRow | null {
  const asked = requested ? rows.find((row) => row.name === requested) : undefined;
  if (asked) return asked;
  return rows.find((row) => row.kind === "ranking") ?? null;
}

/**
 * Which experiments get their numbers read: the busiest few that compared
 * rankings, and always the open one, wherever it sits in the list, so a link
 * straight to it never reads as "did not compare rankings".
 */
export function rowsToMeasure(
  rows: readonly ExperimentRow[],
  open: ExperimentRow | null,
  max: number,
): ExperimentRow[] {
  const busiest = rows.filter((row) => row.kind === "ranking").slice(0, max);
  if (!open || open.kind !== "ranking" || busiest.some((row) => row.name === open.name))
    return busiest;
  return [...busiest, open];
}

/* - Disagreements ------------------------------------------------------------ */

export type ListMark = "same" | "moved" | "only";

export interface DiffItem extends ToolRef {
  /** Where the other variant ranked it, 1-based, or null when it did not return it. */
  otherRank: number | null;
  mark: ListMark;
}

export interface DisagreementRow {
  id: string;
  query: string | null;
  /** ISO time of the search. */
  occurredAt: string;
  kind: "first-pick" | "order" | "results";
  /** Share of results both variants returned, when recorded. */
  agreement: number | null;
  current: { arm: string; items: DiffItem[] };
  comparison: { arm: string; items: DiffItem[] };
  traceHref: string | null;
  /** How the search reopens in the Playground: by the experiment's ids. */
  test: SearchTest | null;
}

export const DISAGREEMENT_LABEL: Record<DisagreementRow["kind"], string> = {
  "first-pick": "Different first pick",
  order: "Same first pick, different order",
  results: "Different results",
};

export interface DisagreementLinks {
  name: (entryId: string) => string;
  traceHref: (row: RankingComparisonRowView) => string | null;
  test: (row: RankingComparisonRowView) => SearchTest | null;
}

export function toDisagreementRows(
  rows: readonly RankingComparisonRowView[],
  links: DisagreementLinks,
): DisagreementRow[] {
  return rows.map((row, index) => {
    const served = row.servedResultIds ?? [];
    const shadow = row.shadowResultIds ?? [];
    return {
      id: row.selectionId ?? `comparison-${row.occurredAt.getTime()}-${index}`,
      query: row.query,
      occurredAt: row.occurredAt.toISOString(),
      kind: disagreementKind(row.top1, served, shadow),
      agreement: row.matchScore,
      current: { arm: row.servedArm ?? "Current", items: diffItems(served, shadow, links) },
      comparison: { arm: row.shadowArm ?? "Comparison", items: diffItems(shadow, served, links) },
      traceHref: links.traceHref(row),
      test: links.test(row),
    };
  });
}

/**
 * What kind of disagreement one comparison is. The recorded first-pick flag
 * wins; without it the lists decide, and with neither nothing is claimed
 * beyond "different results".
 */
export function disagreementKind(
  top1: boolean | null,
  served: readonly string[],
  shadow: readonly string[],
): DisagreementRow["kind"] {
  if (top1 === null && served.length === 0 && shadow.length === 0) return "results";
  const samePick = top1 ?? (served.length > 0 && served[0] === shadow[0]);
  if (!samePick) return "first-pick";
  return diffRankings([...served], [...shadow]).some((entry) => entry.change === "moved")
    ? "order"
    : "results";
}

function diffItems(
  list: readonly string[],
  other: readonly string[],
  links: Pick<DisagreementLinks, "name">,
): DiffItem[] {
  return list.map((id, index) => {
    const position = other.indexOf(id);
    const otherRank = position === -1 ? null : position + 1;
    return {
      id,
      name: links.name(id),
      otherRank,
      mark: otherRank === null ? "only" : otherRank === index + 1 ? "same" : "moved",
    };
  });
}
