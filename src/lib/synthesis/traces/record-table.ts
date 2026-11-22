import type { RecordSort, SortDirection, TraceCursor } from "./queries";
import { buildTraceHref } from "./trace-href";
import { resolveTraceListView, serializeTraceCursor, type TraceListSearchParams } from "./view";

const MAX_TRACE_SELECTION = 2;

export interface TraceListHrefUpdates {
  project?: string | null;
  range?: string | null;
  from?: string | null;
  to?: string | null;
  rootName?: string | null;
  name?: string | null;
  model?: string | null;
  tool?: string | null;
  errorOnly?: boolean | null;
  experiment?: string | null;
  arm?: string | null;
  exactTags?: boolean | null;
  sort?: RecordSort | null;
  direction?: SortDirection | null;
  cursor?: TraceCursor | null;
}

const FILTER_KEYS: readonly (keyof TraceListHrefUpdates)[] = [
  "project",
  "range",
  "from",
  "to",
  "rootName",
  "name",
  "model",
  "tool",
  "errorOnly",
  "experiment",
  "arm",
  "exactTags",
  "sort",
  "direction",
];

export function buildTraceListHref(
  pathname: string,
  params: TraceListSearchParams,
  updates: TraceListHrefUpdates = {},
  now: Date = new Date(),
): string {
  const search = toSearchParams(params);
  const filtersChanged = FILTER_KEYS.some((key) => Object.hasOwn(updates, key));

  applyTextUpdate(search, "project", updates);
  applyTextUpdate(search, "range", updates);
  applyTextUpdate(search, "from", updates);
  applyTextUpdate(search, "to", updates);
  applyTextUpdate(search, "rootName", updates);
  applyTextUpdate(search, "name", updates);
  applyTextUpdate(search, "model", updates);
  applyTextUpdate(search, "tool", updates);
  applyTextUpdate(search, "experiment", updates, updates.exactTags === true);
  applyTextUpdate(search, "arm", updates, updates.exactTags === true);
  applyTextUpdate(search, "sort", updates);
  applyTextUpdate(search, "direction", updates);
  if (
    (Object.hasOwn(updates, "experiment") || Object.hasOwn(updates, "arm")) &&
    !Object.hasOwn(updates, "exactTags")
  ) {
    search.delete("exactTags");
  }
  if (Object.hasOwn(updates, "exactTags")) {
    if (updates.exactTags) search.set("exactTags", "1");
    else search.delete("exactTags");
  }
  if (Object.hasOwn(updates, "errorOnly")) {
    if (updates.errorOnly) search.set("errorOnly", "1");
    else search.delete("errorOnly");
  }
  if (Object.hasOwn(updates, "range") && updates.range !== "custom") {
    if (!Object.hasOwn(updates, "from")) search.delete("from");
    if (!Object.hasOwn(updates, "to")) search.delete("to");
  }
  if (filtersChanged) search.delete("cursor");

  if (Object.hasOwn(updates, "cursor")) {
    if (updates.cursor) {
      const nextView = resolveTraceListView(searchParamsRecord(search), now);
      search.set("cursor", serializeTraceCursor(updates.cursor, nextView.filters));
    } else {
      search.delete("cursor");
    }
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildTraceCompareHref(
  traceRoot: string,
  listSearch: string,
  selectedTraceIds: readonly string[],
): string | null {
  const [leftTraceId, rightTraceId] = selectedTraceIds;
  if (
    selectedTraceIds.length !== MAX_TRACE_SELECTION ||
    !leftTraceId ||
    !rightTraceId ||
    leftTraceId === rightTraceId
  ) {
    return null;
  }

  const search = new URLSearchParams(listSearch.replace(/^\?/, ""));
  search.set("a", leftTraceId);
  search.set("b", rightTraceId);
  return buildTraceHref(traceRoot, "/compare", `?${search.toString()}`);
}

export function toggleTraceSelection(
  selectedTraceIds: readonly string[],
  traceId: string,
): string[] {
  if (selectedTraceIds.includes(traceId)) {
    return selectedTraceIds.filter((selected) => selected !== traceId);
  }
  if (selectedTraceIds.length >= MAX_TRACE_SELECTION) {
    return [...selectedTraceIds];
  }
  return [...selectedTraceIds, traceId];
}

function toSearchParams(params: TraceListSearchParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      search.set(key, value);
    } else if (value !== undefined) {
      for (const item of value) search.append(key, item);
    }
  }
  return search;
}

function searchParamsRecord(search: URLSearchParams): TraceListSearchParams {
  const params: TraceListSearchParams = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }
  return params;
}

function applyTextUpdate(
  search: URLSearchParams,
  key: Exclude<keyof TraceListHrefUpdates, "errorOnly" | "exactTags" | "cursor">,
  updates: TraceListHrefUpdates,
  preserveWhitespace = false,
): void {
  if (!Object.hasOwn(updates, key)) return;
  const value = preserveWhitespace ? updates[key] : updates[key]?.trim();
  if (value) search.set(key, value);
  else search.delete(key);
}
