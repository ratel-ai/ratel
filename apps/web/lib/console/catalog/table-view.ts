import {
  CATALOG_PROVENANCE,
  CATALOG_PROVENANCE_ORDER,
  type CatalogProvenance,
} from "@/lib/ingest/catalogs/vocabulary";
import type { CatalogTool } from "@/lib/synthesis/catalog/tools";
import type { RuntimeCatalogEntry } from "@/lib/synthesis/dashboard";

/**
 * Filtering, sorting and paging for the tools catalog, kept out of the
 * component so the 92-tool case is testable without rendering a table.
 *
 * The URL-param shape follows `lib/traces/calibration-view.ts` (bounded
 * one-based page + page size + offset) rather than inventing a third pagination
 * style for this surface.
 */

export type ToolsCatalogSortKey = "name" | "calls" | "tokens" | "cost" | "lastSeen";

export type SortDirection = "asc" | "desc";

export type ProvenanceFilter = CatalogProvenance | "all";

export interface ToolsCatalogView {
  query: string;
  provenance: ProvenanceFilter;
  sort: ToolsCatalogSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
  offset: number;
}

export interface ToolsCatalogSearchParams {
  q?: string;
  provenance?: string;
  sort?: string;
  dir?: string;
  page?: string;
  pageSize?: string;
}

/** One table row: the tool, plus everything the row needs to render itself. */
export interface ToolsCatalogRow {
  tool: CatalogTool;
  provenance: CatalogProvenance;
  /** The runtime definition when this row is editable, else null. */
  definition: Extract<RuntimeCatalogEntry, { entryId: string }> | null;
  /** Every synced source for this tool has gone quiet past the staleness threshold. */
  stale: boolean;
}

export const TOOLS_CATALOG_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_TOOLS_CATALOG_PAGE_SIZE = 25;
export const DEFAULT_TOOLS_CATALOG_SORT: ToolsCatalogSortKey = "calls";
export const DEFAULT_TOOLS_CATALOG_DIRECTION: SortDirection = "desc";

const SORT_KEYS: readonly ToolsCatalogSortKey[] = ["name", "calls", "tokens", "cost", "lastSeen"];

const PROVENANCE_FILTERS: readonly ProvenanceFilter[] = ["all", "managed", "cloud", "observed"];

/**
 * Pair each tool with the runtime entry that shares its name. A tool is
 * `managed` only when the runtime actually ingested a definition for it. An
 * entry with a null `entryId` is an observation, which is exactly the row Cloud
 * cannot edit.
 */
export function buildToolsCatalogRows(
  tools: readonly CatalogTool[],
  entriesByName: ReadonlyMap<string, RuntimeCatalogEntry>,
): ToolsCatalogRow[] {
  return tools.map((tool) => {
    const entry = entriesByName.get(tool.name);
    const definition = entry && entry.entryId !== null ? entry : null;
    return {
      tool,
      provenance: definition ? "managed" : "observed",
      definition,
      // Every source, not any: sources are unioned by tool name, so a project
      // that re-onboarded under a new source id carries each tool under both
      // the abandoned source and the one publishing now. Flagging on `some`
      // called the whole catalog stale while snapshots arrived every minute.
      // One live source is enough to say this definition is current.
      stale:
        tool.sources.length > 0 && tool.sources.every((source) => source.sourceStatus === "stale"),
    };
  });
}

/**
 * Name-and-description substring match plus a provenance facet. Client-side is
 * fine at catalog scale: the page already holds every row in memory to compute
 * its totals, so filtering here costs nothing a round trip would save.
 */
export function filterToolsCatalogRows(
  rows: readonly ToolsCatalogRow[],
  view: Pick<ToolsCatalogView, "query" | "provenance">,
): ToolsCatalogRow[] {
  const needle = view.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (view.provenance !== "all" && row.provenance !== view.provenance) {
      return false;
    }
    if (needle === "") return true;
    return (
      row.tool.name.toLowerCase().includes(needle) ||
      row.tool.description.toLowerCase().includes(needle)
    );
  });
}

/**
 * Sort a copy, because callers hold the unsorted array in React state and must
 * not see
 * it reordered underneath them.
 *
 * The default (`calls` descending) reproduces the previously hardcoded order
 * from `buildToolsCatalog`: calls desc, then tokens desc, then name asc. Every
 * comparator falls through to name so paging is stable when a column ties,
 * which it does constantly here, since most rows have zero calls.
 */
export function sortToolsCatalogRows(
  rows: readonly ToolsCatalogRow[],
  sort: ToolsCatalogSortKey,
  direction: SortDirection,
): ToolsCatalogRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareBy(a, b, sort);
    if (primary !== 0) return primary * sign;
    if (sort === "calls") {
      const tokens = compareBy(a, b, "tokens");
      if (tokens !== 0) return tokens * sign;
    }
    return a.tool.name.localeCompare(b.tool.name);
  });
}

function compareBy(a: ToolsCatalogRow, b: ToolsCatalogRow, sort: ToolsCatalogSortKey): number {
  switch (sort) {
    case "name":
      return a.tool.name.localeCompare(b.tool.name);
    case "calls":
      return a.tool.calls - b.tool.calls;
    case "tokens":
      return a.tool.tokens - b.tool.tokens;
    case "cost":
      return a.tool.costUsd - b.tool.costUsd;
    case "lastSeen":
      return lastSeenMs(a) - lastSeenMs(b);
  }
}

/** Never-seen rows sort as oldest rather than jumping to the top. */
function lastSeenMs(row: ToolsCatalogRow): number {
  return row.tool.lastSeenAt ? row.tool.lastSeenAt.getTime() : 0;
}

/** Resolve the browser's filter, sort and bounded one-based page from the URL. */
export function resolveToolsCatalogView(
  params: ToolsCatalogSearchParams,
  total?: number,
): ToolsCatalogView {
  const requestedPageSize = Number(params.pageSize);
  const pageSize = TOOLS_CATALOG_PAGE_SIZES.includes(
    requestedPageSize as (typeof TOOLS_CATALOG_PAGE_SIZES)[number],
  )
    ? requestedPageSize
    : DEFAULT_TOOLS_CATALOG_PAGE_SIZE;
  const requestedPage = Number(params.page);
  const unboundedPage =
    Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageCount =
    total === undefined ? unboundedPage : Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const page = Math.min(unboundedPage, pageCount);
  return {
    query: typeof params.q === "string" ? params.q : "",
    provenance: PROVENANCE_FILTERS.includes(params.provenance as ProvenanceFilter)
      ? (params.provenance as ProvenanceFilter)
      : "all",
    sort: SORT_KEYS.includes(params.sort as ToolsCatalogSortKey)
      ? (params.sort as ToolsCatalogSortKey)
      : DEFAULT_TOOLS_CATALOG_SORT,
    direction: params.dir === "asc" ? "asc" : DEFAULT_TOOLS_CATALOG_DIRECTION,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

/**
 * Serialize a view back to query params, omitting defaults so an untouched
 * table has a clean URL and the Back button does not walk through no-op states.
 */
export function toolsCatalogSearchParams(view: ToolsCatalogView): URLSearchParams {
  const search = new URLSearchParams();
  if (view.query.trim() !== "") search.set("q", view.query);
  if (view.provenance !== "all") search.set("provenance", view.provenance);
  if (view.sort !== DEFAULT_TOOLS_CATALOG_SORT) search.set("sort", view.sort);
  if (view.direction !== DEFAULT_TOOLS_CATALOG_DIRECTION) {
    search.set("dir", view.direction);
  }
  if (view.page > 1) search.set("page", String(view.page));
  if (view.pageSize !== DEFAULT_TOOLS_CATALOG_PAGE_SIZE) {
    search.set("pageSize", String(view.pageSize));
  }
  return search;
}

/** Human-readable position of one page within its filtered result set. */
export function toolsCatalogRangeLabel(offset: number, rowCount: number, total: number): string {
  if (rowCount === 0) return `0 of ${total.toLocaleString("en-US")}`;
  const first = offset + 1;
  const last = Math.min(offset + rowCount, total);
  return `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

/** Clicking the active column flips direction; a new column starts at its natural end. */
export function nextSortDirection(
  view: Pick<ToolsCatalogView, "sort" | "direction">,
  column: ToolsCatalogSortKey,
): SortDirection {
  if (view.sort !== column) return column === "name" ? "asc" : "desc";
  return view.direction === "asc" ? "desc" : "asc";
}

/**
 * The source facet's options: "all", plus only the provenances this catalog
 * actually contains. Offering "Cloud" on a table with no Cloud-authored rows is
 * a filter whose only outcome is an empty page.
 *
 * The current selection is always kept, so a deep link to a facet that no
 * longer matches anything still shows what it filtered by rather than silently
 * resetting to "all".
 */
export function provenanceFilterChoices(
  available: readonly CatalogProvenance[],
  selected: ProvenanceFilter,
): { value: string; label: string; hint?: string }[] {
  return [
    { value: "all", label: "All sources" },
    ...CATALOG_PROVENANCE_ORDER.filter(
      (provenance) => available.includes(provenance) || selected === provenance,
    ).map((provenance) => ({
      value: provenance,
      label: CATALOG_PROVENANCE[provenance].label,
      hint: CATALOG_PROVENANCE[provenance].hint,
    })),
  ];
}

/** Which provenances a set of rows actually contains, in catalog order. */
export function presentProvenances(rows: readonly ToolsCatalogRow[]): CatalogProvenance[] {
  return CATALOG_PROVENANCE_ORDER.filter((provenance) =>
    rows.some((row) => row.provenance === provenance),
  );
}

/** True when at least one row in the catalog carries OTel-derived usage. */
export function hasObservedUsage(rows: readonly ToolsCatalogRow[]): boolean {
  return rows.some(
    (row) => row.tool.tokensProvenance !== "absent" || row.tool.costProvenance !== "absent",
  );
}
