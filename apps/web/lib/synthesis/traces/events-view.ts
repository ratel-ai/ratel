import type { RangePreset, ResolvedRange } from "@/lib/synthesis/dashboard";
import type { EventCursor, ListProjectEventsOptions } from "./events-queries";
import { resolveTraceRange, type TraceSearchParamValue } from "./view";

export interface EventListSearchParams {
  [key: string]: TraceSearchParamValue;
  project?: TraceSearchParamValue;
  range?: TraceSearchParamValue;
  from?: TraceSearchParamValue;
  to?: TraceSearchParamValue;
  eventName?: TraceSearchParamValue;
  experiment?: TraceSearchParamValue;
  tracelessOnly?: TraceSearchParamValue;
  cursor?: TraceSearchParamValue;
}

export interface EventListFilters {
  project: string;
  range: RangePreset | "custom";
  from: string;
  to: string;
  eventName: string;
  experiment: string;
  tracelessOnly: boolean;
}

export interface EventListView {
  range: ResolvedRange;
  filters: EventListFilters;
  queryOptions: ListProjectEventsOptions;
}

export interface EventListHrefUpdates {
  project?: string | null;
  range?: string | null;
  from?: string | null;
  to?: string | null;
  eventName?: string | null;
  experiment?: string | null;
  tracelessOnly?: boolean | null;
  cursor?: EventCursor | null;
}

const EVENT_CURSOR_VERSION = 2;
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEYS: readonly (keyof EventListHrefUpdates)[] = [
  "project",
  "range",
  "from",
  "to",
  "eventName",
  "experiment",
  "tracelessOnly",
];

export function resolveEventListView(
  params: EventListSearchParams,
  now: Date = new Date(),
): EventListView {
  const range = resolveTraceRange(params, now);
  const eventName = textParam(params.eventName);
  const experiment = textParam(params.experiment);
  const tracelessOnly = ["1", "true"].includes(textParam(params.tracelessOnly).toLowerCase());
  const filters: EventListFilters = {
    project: textParam(params.project),
    range: range.preset,
    from: range.from,
    to: range.to,
    eventName,
    experiment,
    tracelessOnly,
  };
  const cursor = parseEventCursor(textParam(params.cursor), filters);

  return {
    range,
    filters,
    queryOptions: {
      since: range.since,
      until: range.until,
      eventName: eventName || undefined,
      experiment: experiment || undefined,
      tracelessOnly,
      ...(cursor ? { cursor } : {}),
    },
  };
}

export function buildEventListHref(
  pathname: string,
  params: EventListSearchParams,
  updates: EventListHrefUpdates = {},
  now: Date = new Date(),
): string {
  const search = toSearchParams(params);
  const filtersChanged = FILTER_KEYS.some((key) => Object.hasOwn(updates, key));

  applyTextUpdate(search, "project", updates);
  applyTextUpdate(search, "range", updates);
  applyTextUpdate(search, "from", updates);
  applyTextUpdate(search, "to", updates);
  applyTextUpdate(search, "eventName", updates);
  applyTextUpdate(search, "experiment", updates);
  if (Object.hasOwn(updates, "tracelessOnly")) {
    if (updates.tracelessOnly) search.set("tracelessOnly", "1");
    else search.delete("tracelessOnly");
  }
  if (Object.hasOwn(updates, "range") && updates.range !== "custom") {
    if (!Object.hasOwn(updates, "from")) search.delete("from");
    if (!Object.hasOwn(updates, "to")) search.delete("to");
  }
  if (filtersChanged) search.delete("cursor");

  if (Object.hasOwn(updates, "cursor")) {
    if (updates.cursor) {
      const nextView = resolveEventListView(Object.fromEntries(search.entries()), now);
      search.set("cursor", serializeEventCursor(updates.cursor, nextView.filters));
    } else {
      search.delete("cursor");
    }
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function serializeEventCursor(cursor: EventCursor, filters: EventListFilters): string {
  const occurredAt = cursor.occurredAt.toISOString();
  if (!validEventId(cursor.id)) {
    throw new TypeError("Invalid event cursor");
  }
  return JSON.stringify([EVENT_CURSOR_VERSION, occurredAt, cursor.id, ...cursorContext(filters)]);
}

export function parseEventCursor(
  token: string | undefined,
  filters: EventListFilters,
): EventCursor | undefined {
  if (!token) return undefined;
  try {
    const payload: unknown = JSON.parse(token);
    if (
      !Array.isArray(payload) ||
      payload.length !== 10 ||
      payload[0] !== EVENT_CURSOR_VERSION ||
      typeof payload[1] !== "string" ||
      typeof payload[2] !== "string" ||
      !validEventId(payload[2]) ||
      JSON.stringify(payload.slice(3)) !== JSON.stringify(cursorContext(filters))
    ) {
      return undefined;
    }
    const occurredAt = new Date(payload[1]);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== payload[1]) {
      return undefined;
    }
    return { occurredAt, id: payload[2] };
  } catch {
    return undefined;
  }
}

function cursorContext(filters: EventListFilters): readonly (string | number)[] {
  return [
    filters.project,
    filters.range,
    filters.from,
    filters.to,
    filters.eventName,
    filters.experiment,
    filters.tracelessOnly ? 1 : 0,
  ];
}

function validEventId(value: string): boolean {
  return EVENT_ID_PATTERN.test(value);
}

function toSearchParams(params: EventListSearchParams): URLSearchParams {
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

function applyTextUpdate(
  search: URLSearchParams,
  key: Exclude<keyof EventListHrefUpdates, "tracelessOnly" | "cursor">,
  updates: EventListHrefUpdates,
): void {
  if (!Object.hasOwn(updates, key)) return;
  const value = updates[key]?.trim();
  if (value) search.set(key, value);
  else search.delete(key);
}

function textParam(value: TraceSearchParamValue): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ?? "";
}
