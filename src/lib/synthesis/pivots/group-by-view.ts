import type { PivotGroupBy } from "@/lib/synthesis/pivots/group-by";
import { type PivotFilterOption, pivotFilterSearch } from "@/lib/synthesis/traces/v2/filters";

/**
 * The Overview group-by table (RC-886) as the page shows it: which pivot is
 * picked, and one row per value, "Other" and "(none)". A value row links to
 * Sessions filtered by that value.
 */

export interface PivotGroupRowView {
  key: string;
  label: string;
  /** "Other" and "(none)" are not a value: they show muted and link nowhere. */
  muted: boolean;
  runs: number;
  /** Share of the window's runs, 0 to 1. */
  share: number;
  errorRate: number;
  p50Ms: number;
  costUsd: number;
  href: string | null;
}

/** The query parameter of the picked pivot on Overview. */
export const OVERVIEW_PIVOT_PARAM = "pivot";
export const OTHER_LABEL = "Other";
export const NONE_LABEL = "(none)";

/** The pivot `?pivot=` names when it is configured, else the first one. Null with no pivot. */
export function pickGroupPivot(
  pivots: readonly PivotFilterOption[],
  raw: string | readonly string[] | undefined,
): PivotFilterOption | null {
  const wanted = typeof raw === "string" ? raw : raw?.[0];
  return pivots.find((pivot) => pivot.key === wanted) ?? pivots[0] ?? null;
}

export function pivotGroupRowViews(
  groupBy: PivotGroupBy,
  pivotKey: string,
  root: string,
): PivotGroupRowView[] {
  const total = groupBy.totalRuns || 1;
  return groupBy.rows.map((row) => {
    const value = row.kind === "value" ? row.value : null;
    return {
      key: value === null ? `:${row.kind}` : `=${value}`,
      label: value ?? (row.kind === "other" ? OTHER_LABEL : NONE_LABEL),
      muted: value === null,
      runs: row.runs,
      share: row.runs / total,
      errorRate: row.errorRate,
      p50Ms: row.p50Ms,
      costUsd: row.costUsd,
      href: value === null ? null : `${root}/traces${pivotFilterSearch(pivotKey, value)}`,
    };
  });
}

/** The Overview query string with another pivot picked: the window stays. */
export function withGroupPivot(search: string, key: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.set(OVERVIEW_PIVOT_PARAM, key);
  return `?${params.toString()}`;
}
