import type {
  ComparisonFacet,
  ComparisonFilterSelection,
  ComparisonMatchMode,
} from "@/lib/synthesis/experiments/calibration-types";
import type { MetricDelta } from "@/lib/synthesis/experiments/types";
import { experimentDetailPath } from "./experiment-view";

export interface ComparisonBrowserView {
  selection: ComparisonFilterSelection;
  page: number;
  pageSize: number;
  offset: number;
}

export interface ComparisonBrowserSearchParams {
  comparisons?: string;
  comparisonMatch?: string;
  comparisonPage?: string;
  comparisonPageSize?: string;
}

export type OutcomeTone = "ok" | "warn" | "error" | "muted";

const OUTCOME_TONES: Record<string, OutcomeTone> = {
  ok: "ok",
  empty: "warn",
  error: "error",
  timeout: "error",
};
/** Canonical facet order — selections are normalised so URLs stay stable. */
export const COMPARISON_FACETS: readonly ComparisonFacet[] = [
  "top1",
  "order",
  "missing",
  "added",
  "outcome",
];
export const COMPARISON_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_COMPARISON_PAGE_SIZE = 25;

/** Scoped calibration detail path for an experiment name (reversible segment). */
export function calibrationDetailPath(basePath: string, name: string): string {
  return `${basePath}${experimentDetailPath(name).slice("/experiments".length)}`;
}

/** Mismatch browser nested under one calibration experiment. */
export function calibrationMismatchesPath(basePath: string, name: string): string {
  return `${calibrationDetailPath(basePath, name)}/mismatches`;
}

/** Selection-inspector path nested under the experiment detail. */
export function calibrationSelectionPath(
  basePath: string,
  name: string,
  selectionId: string,
): string {
  return `${calibrationDetailPath(basePath, name)}/selection/${encodeURIComponent(selectionId)}`;
}

/** Resolve the comparison browser's filter and bounded, one-based page. */
export function resolveComparisonBrowserView(
  params: ComparisonBrowserSearchParams,
  total?: number,
): ComparisonBrowserView {
  const selection = resolveComparisonSelection(params.comparisons, params.comparisonMatch);
  const requestedPageSize = Number(params.comparisonPageSize);
  const pageSize = COMPARISON_PAGE_SIZES.includes(
    requestedPageSize as (typeof COMPARISON_PAGE_SIZES)[number],
  )
    ? requestedPageSize
    : DEFAULT_COMPARISON_PAGE_SIZE;
  const requestedPage = Number(params.comparisonPage);
  const unboundedPage =
    Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageCount =
    total === undefined ? unboundedPage : Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const page = Math.min(unboundedPage, pageCount);
  return { selection, page, pageSize, offset: (page - 1) * pageSize };
}

/** Normalize a Next search param that may appear more than once. */
export function singleSearchParam(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** Human-readable position of one page within its filtered result set. */
export function comparisonRangeLabel(offset: number, rowCount: number, total: number): string {
  if (rowCount === 0) return `0 of ${total.toLocaleString("en-US")}`;
  const first = offset + 1;
  const last = Math.min(offset + rowCount, total);
  return `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

/**
 * Read the browser's filter out of the URL. `comparisons` is a comma-separated
 * facet list (`top1,order`), optionally carrying the `all` scope token; the
 * legacy single-value form (`mismatch`, `all`, `top1`, …) still parses so links
 * already in the wild keep working. Unknown tokens are dropped rather than
 * failing the page, and `comparisonMatch=all` switches OR into AND.
 */
export function resolveComparisonSelection(
  comparisons: string | undefined,
  match: string | undefined,
): ComparisonFilterSelection {
  const tokens = new Set(
    (comparisons ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
  return {
    scope: tokens.has("all") ? "all" : "mismatch",
    facets: COMPARISON_FACETS.filter((facet) => tokens.has(facet)),
    match: resolveComparisonMatch(match),
  };
}

/** Add or remove one facet, keeping the canonical facet order. */
export function toggleComparisonFacet(
  selection: ComparisonFilterSelection,
  facet: ComparisonFacet,
): ComparisonFilterSelection {
  const facets = selection.facets.includes(facet)
    ? selection.facets.filter((selected) => selected !== facet)
    : COMPARISON_FACETS.filter(
        (candidate) => candidate === facet || selection.facets.includes(candidate),
      );
  return { ...selection, facets };
}

/** Serialise a selection back into the `comparisons` URL parameter. */
export function comparisonFilterParam(selection: ComparisonFilterSelection): string {
  const tokens = [...(selection.scope === "all" ? ["all"] : []), ...selection.facets];
  return tokens.length === 0 ? "mismatch" : tokens.join(",");
}

/** Full query string for one browser state, on top of the range params. */
export function comparisonSearchParams(
  base: URLSearchParams,
  view: ComparisonBrowserView,
): URLSearchParams {
  const search = new URLSearchParams(base);
  search.set("comparisons", comparisonFilterParam(view.selection));
  search.delete("comparisonMatch");
  if (view.selection.match === "all") search.set("comparisonMatch", "all");
  search.delete("comparisonPage");
  if (view.page > 1) search.set("comparisonPage", String(view.page));
  search.set("comparisonPageSize", String(view.pageSize));
  return search;
}

function resolveComparisonMatch(value: string | undefined): ComparisonMatchMode {
  return value === "all" ? "all" : "any";
}

/** Render a 0..1 agreement score as a whole percentage. */
/**
 * Which row the accordion should hold open after one `<details>` toggle.
 *
 * Not simply "the row that reported it". Opening row B while row A is open
 * makes React set `open={false}` on A, and the browser answers that with A's
 * OWN toggle event, fired asynchronously, so it lands after B has already been
 * recorded. Treating that as a user closing A wiped out B, which showed up as
 * the previous row collapsing and the clicked one never opening.
 *
 * A close therefore only counts when it names the row that is actually open.
 */
export function nextOpenComparisonRow(
  current: string | null,
  key: string,
  opened: boolean,
): string | null {
  if (opened) return key;
  return current === key ? null : current;
}

export function formatScore(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}%`;
}

/** Presentation tone for an SDK arm outcome (ok | empty | error | timeout). */
export function outcomeTone(outcome: string | null): OutcomeTone {
  return outcome === null ? "muted" : (OUTCOME_TONES[outcome] ?? "muted");
}

/** Shadow latency versus the served baseline, in DeltaChip vocabulary. */
export function latencyDelta(servedMs: number | null, shadowMs: number | null): MetricDelta | null {
  if (servedMs === null || shadowMs === null) return null;
  const absolute = shadowMs - servedMs;
  return {
    absolute,
    relative: servedMs === 0 ? null : absolute / servedMs,
  };
}
