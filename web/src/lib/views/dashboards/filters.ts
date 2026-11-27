import { z } from "zod";
import { filterProblem } from "@/lib/contracts/filter-budget";
import { traceFilterShape } from "@/lib/contracts/query";
import { RANGE_PRESETS, type RangePreset } from "@/lib/synthesis/dashboard";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import {
  type FilterFieldId,
  packFilter,
  traceFilterFromSearch,
  unpackFilter,
} from "@/lib/synthesis/traces/v2/filters";
import { MAX_PLAIN_CHARS, searchFromTraceFilter } from "@/lib/views/dashboards/links";
import type {
  DashboardDefaults,
  DashboardFilters,
  WidgetQuery,
} from "@/lib/views/dashboards/types";
import { isFilterable, queryFilter, withFilter } from "@/lib/views/dashboards/widget";

/**
 * A dashboard's filters in its address. The address wins over the saved ones as a whole; one
 * parameter says "no filter at all", so cleared filters do not come back, or has long filters packed. Safe for the browser.
 */

/** The fields of the filter bar. */
export const DASHBOARD_FILTER_FIELDS: readonly FilterFieldId[] = [
  "environment",
  "service",
  "model",
  "agent",
];

const NO_FILTERS = { param: "filters", value: "none" } as const;
const PARAMS = ["facetEnvironment", "facetService", "facetModel", "facetAgent"] as const;

const { environments, services, models, agents } = traceFilterShape;
/** A longer address has its panels, or its query, in the fragment. */
export const MAX_SEARCH_CHARS = 3_000;
export const dashboardFiltersSchema = z
  .strictObject({ environments, services, models, agents })
  .refine((filters) => filterProblem(filters) === null, {
    error: ({ input }) => filterProblem(input as object) ?? "",
  });
export const defaultsSchema = z.strictObject({
  filters: dashboardFiltersSchema,
  range: z.enum(RANGE_PRESETS.map(({ id }) => id) as [RangePreset, ...RangePreset[]]).nullable(),
});

/** Why filters from outside are refused, in words. */
export function filtersRefusal({ issues }: z.ZodError): string {
  return (
    issues.find(({ code }) => code === "custom")?.message ?? "The dashboard filters are invalid."
  );
}

/** The filters a dashboard shows: its address's, else its saved ones. */
export function shownFilters(search: string, saved: DashboardFilters): DashboardFilters {
  return hasOwnFilters(new URLSearchParams(search))
    ? (traceFilterFromSearch(barSearch(search, saved), { entities: true }) as DashboardFilters)
    : saved;
}

/** The query string of the filter bar alone. */
export function barSearch(search: string, saved: DashboardFilters): string {
  const params = new URLSearchParams(search);
  if (!hasOwnFilters(params)) return searchFromTraceFilter(saved);
  const packed = unpackFilter(params.get(NO_FILTERS.param) ?? "");
  const said = packed ? new URLSearchParams(searchFromTraceFilter(packed)) : params;
  const own = new URLSearchParams();
  for (const name of PARAMS) for (const value of said.getAll(name)) own.append(name, value);
  return own.size > 0 ? `?${own}` : "";
}

/** The address with what the bar now says; the rest of it stays. */
export function withBarSearch(search: string, bar: string, saved: DashboardFilters): string {
  const params = new URLSearchParams(withoutOwnFilters(search));
  const next = new URLSearchParams(bar);
  if (bar.length > MAX_PLAIN_CHARS)
    params.set(NO_FILTERS.param, packFilter(traceFilterFromSearch(bar, { entities: true })));
  else for (const name of PARAMS) for (const value of next.getAll(name)) params.append(name, value);
  if (next.size === 0 && Object.keys(saved).length > 0)
    params.set(NO_FILTERS.param, NO_FILTERS.value);
  return params.size > 0 ? `?${params}` : "";
}

/** The address that shows the saved filters and time range. */
export function withoutOwnView(search: string): string {
  const params = new URLSearchParams(withoutOwnFilters(search));
  for (const name of ["range", "from", "to"]) params.delete(name);
  return params.size > 0 ? `?${params}` : "";
}

export function sameDefaults(a: DashboardDefaults, b: DashboardDefaults): boolean {
  return a.range === b.range && canonical(a.filters) === canonical(b.filters);
}

/** The query with the page's filters as one more clause. A measure that cannot be filtered stays. */
export function withPageFilters<Q extends WidgetQuery>(query: Q, page: DashboardFilters): Q {
  return isFilterable(query) ? withFilter(query, withClause(queryFilter(query), page)) : query;
}

/** Whether `withPageFilters` adds a clause. */
export function takesPageFilters(query: WidgetQuery, page: DashboardFilters): boolean {
  const own = queryFilter(query);
  return isFilterable(query) && withClause(own, page) !== own;
}

/** The address after a change in the filter bar, or why a query on the page cannot take it. */
export function barChange(
  next: string | ((bar: string) => string),
  {
    search,
    saved,
    queries,
  }: { search: string; saved: DashboardFilters; queries: readonly WidgetQuery[] },
): { go: (current: string) => string; refused: string | null } {
  const go = (current: string) => {
    const bar = barSearch(current, saved);
    return withBarSearch(current, typeof next === "function" ? next(bar) : next, saved);
  };
  return { go, refused: filtersProblem(queries, shownFilters(go(search), saved)) };
}

/** Why the filters of a page are too long, alone or together with those of a query on it, or null. */
export function filtersProblem(
  queries: readonly WidgetQuery[],
  page: DashboardFilters,
): string | null {
  const all = [page, ...queries.map((query) => queryFilter(withPageFilters(query, page)))];
  return all.map(filterProblem).find((problem) => problem !== null) ?? null;
}

function hasOwnFilters(params: URLSearchParams): boolean {
  return params.has(NO_FILTERS.param) || PARAMS.some((name) => params.has(name));
}

function withoutOwnFilters(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of [NO_FILTERS.param, ...PARAMS]) params.delete(name);
  return params.toString();
}

function canonical({ environments, services, models, agents }: DashboardFilters): string {
  return JSON.stringify(
    [environments, services, models, agents].map((values) => [...(values ?? [])].sort()),
  );
}
