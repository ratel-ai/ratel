import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import type { RangePreset, ResolvedRange } from "@/lib/synthesis/dashboard";
import type {
  ListOperationsOptions,
  ListSpansOptions,
  ListTracesOptions,
  OperationGroupBy,
  OperationSort,
  RecordSort,
  SortDirection,
  SpanCursor,
  SpanSummary,
  TraceCursor,
  TraceFacetFilters,
  TraceSummary,
} from "./queries";

export type TraceSearchParamValue = string | readonly string[] | undefined;

export interface TraceListSearchParams {
  [key: string]: TraceSearchParamValue;
  project?: TraceSearchParamValue;
  range?: TraceSearchParamValue;
  from?: TraceSearchParamValue;
  to?: TraceSearchParamValue;
  rootName?: TraceSearchParamValue;
  name?: TraceSearchParamValue;
  model?: TraceSearchParamValue;
  tool?: TraceSearchParamValue;
  scope?: TraceSearchParamValue;
  groupBy?: TraceSearchParamValue;
  sort?: TraceSearchParamValue;
  direction?: TraceSearchParamValue;
  errorOnly?: TraceSearchParamValue;
  experiment?: TraceSearchParamValue;
  arm?: TraceSearchParamValue;
  exactTags?: TraceSearchParamValue;
  cursor?: TraceSearchParamValue;
  comparisons?: TraceSearchParamValue;
  comparisonMatch?: TraceSearchParamValue;
  comparisonPage?: TraceSearchParamValue;
  comparisonPageSize?: TraceSearchParamValue;
  facetService?: TraceSearchParamValue;
  facetName?: TraceSearchParamValue;
  facetStatus?: TraceSearchParamValue;
  facetKind?: TraceSearchParamValue;
  facetEnvironment?: TraceSearchParamValue;
  facetModel?: TraceSearchParamValue;
  facetExperiment?: TraceSearchParamValue;
  facetArm?: TraceSearchParamValue;
  minDurationMs?: TraceSearchParamValue;
  maxDurationMs?: TraceSearchParamValue;
  minTokens?: TraceSearchParamValue;
  maxTokens?: TraceSearchParamValue;
  minCostUsd?: TraceSearchParamValue;
  maxCostUsd?: TraceSearchParamValue;
}

export interface TraceCompareSearchParams extends TraceListSearchParams {
  a?: TraceSearchParamValue;
  b?: TraceSearchParamValue;
}

export interface TraceListFilters {
  project: string;
  range: RangePreset | "custom";
  from: string;
  to: string;
  rootName: string;
  name: string;
  model: string;
  tool: string;
  errorOnly: boolean;
  experiment: string;
  arm: string;
  exactTags: boolean;
  sort: RecordSort;
  direction: SortDirection;
  facets?: TraceFacetFilters;
}

export interface TraceListView {
  range: ResolvedRange;
  filters: TraceListFilters;
  queryOptions: ListTracesOptions;
}

export interface SpanListFilters {
  project: string;
  range: RangePreset | "custom";
  from: string;
  to: string;
  scope: "all" | "root";
  name: string;
  model: string;
  tool: string;
  experiment: string;
  arm: string;
  exactTags: boolean;
  errorOnly: boolean;
  sort: RecordSort;
  direction: SortDirection;
  facets?: TraceFacetFilters;
}

export interface SpanListView {
  range: ResolvedRange;
  filters: SpanListFilters;
  queryOptions: ListSpansOptions;
}

export interface OperationsFilters {
  project: string;
  range: RangePreset | "custom";
  from: string;
  to: string;
  name: string;
  model: string;
  tool: string;
  experiment: string;
  errorOnly: boolean;
  groupBy: OperationGroupBy;
  sort: OperationSort;
  direction: SortDirection;
  facets?: TraceFacetFilters;
}

export interface OperationsView {
  range: ResolvedRange;
  filters: OperationsFilters;
  queryOptions: ListOperationsOptions;
}

export interface SpanListHrefUpdates {
  project?: string | null;
  range?: string | null;
  from?: string | null;
  to?: string | null;
  scope?: "all" | "root" | null;
  name?: string | null;
  model?: string | null;
  tool?: string | null;
  experiment?: string | null;
  arm?: string | null;
  /** Pass `null` to drop exact-tag matching along with the tags themselves. */
  exactTags?: boolean | null;
  errorOnly?: boolean | null;
  sort?: RecordSort | null;
  direction?: SortDirection | null;
  cursor?: SpanCursor | null;
}

export interface OperationsHrefUpdates {
  groupBy?: OperationGroupBy | null;
  sort?: OperationSort | null;
  direction?: SortDirection | null;
}

export type TraceSummaryView = Omit<TraceSummary, "startedAt" | "endedAt"> & {
  startedAt: string;
  endedAt: string;
};

export type SpanSummaryView = Omit<SpanSummary, "startedAt"> & {
  startedAt: string;
};

/**
 * Client-facing span shape: serialized dates, minus the row/scope identifiers
 * (`id`, `projectId`, `traceId`) the UI never renders — on a 5,000-span
 * waterfall those repeat into real payload weight.
 */
export type TraceSpanView = Omit<
  OtelSpan,
  "startedAt" | "endedAt" | "id" | "projectId" | "traceId"
> & {
  startedAt: string;
  endedAt: string;
};

/** Window every telemetry surface falls back to when `?range=` is absent or invalid. */
export const DEFAULT_TRACE_RANGE: RangePreset = "7d";

const DAY_MS = 86_400_000;
const MAX_TRACE_RANGE_DAYS = 372;
const MAX_TRACE_DAY = "9999-12-30";
const TRACE_RANGE_LABELS: Record<RangePreset, string> = {
  "7d": "last 7 days",
  "14d": "last 14 days",
  "30d": "last 30 days",
  "3m": "last 3 months",
  "12m": "last 12 months",
};
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_CURSOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_GROUPS: ReadonlySet<string> = new Set(["name", "model", "tool"]);
const OPERATION_SORTS: ReadonlySet<string> = new Set([
  "key",
  "count",
  "errorRate",
  "p50",
  "p95",
  "p99",
  "cost",
  "tokens",
]);
const RECORD_SORTS: ReadonlySet<string> = new Set(["started", "duration", "tokens", "cost"]);

export function resolveTraceListView(
  params: TraceListSearchParams,
  now: Date = new Date(),
): TraceListView {
  const range = resolveTraceRange(params, now);
  const rootName = textParam(params.rootName);
  const name = textParam(params.name);
  const model = textParam(params.model);
  const tool = textParam(params.tool);
  const exactTags = textParam(params.exactTags) === "1";
  const facets = resolveTraceFacetFilters(params);
  const experiment = exactTags ? exactTextParam(params.experiment) : textParam(params.experiment);
  const arm = exactTags ? exactTextParam(params.arm) : textParam(params.arm);
  const errorOnly = ["1", "true"].includes(textParam(params.errorOnly).toLowerCase());
  const { sort, direction } = resolveRecordSort(params);
  const filters: TraceListFilters = {
    project: textParam(params.project),
    range: range.preset,
    from: range.from,
    to: range.to,
    rootName,
    name,
    model,
    tool,
    errorOnly,
    experiment,
    arm,
    exactTags,
    sort,
    direction,
    ...(hasTraceFacetFilters(facets) ? { facets } : {}),
  };
  const cursor = parseTraceCursor(textParam(params.cursor), filters);

  return {
    range,
    filters,
    queryOptions: {
      since: range.since,
      until: range.until,
      rootName: rootName || undefined,
      ...(name ? { spanName: name } : {}),
      ...(model ? { model } : {}),
      ...(tool ? { tool } : {}),
      errorOnly,
      experiment: experiment || undefined,
      arm: arm || undefined,
      sort,
      direction,
      ...(cursor ? { cursor } : {}),
      ...facets,
    },
  };
}

export function resolveSpanListView(
  params: TraceListSearchParams,
  now: Date = new Date(),
): SpanListView {
  const range = resolveTraceRange(params, now);
  const facets = resolveTraceFacetFilters(params);
  const { sort, direction } = resolveRecordSort(params);
  const exactTags = textParam(params.exactTags) === "1";
  const filters: SpanListFilters = {
    project: textParam(params.project),
    range: range.preset,
    from: range.from,
    to: range.to,
    scope: textParam(params.scope) === "root" ? "root" : "all",
    name: textParam(params.name),
    model: textParam(params.model),
    tool: textParam(params.tool),
    // Experiment and arm carry the same exact-vs-substring semantics as the
    // trace list (`?exactTags=1`), so a link built for one surface means the
    // same thing on the other. Dropping them here is what let a deep link from
    // an experiment finding filter the records while the filter bar above them
    // rendered empty — and then silently discard the arm on the next Apply.
    experiment: exactTags ? exactTextParam(params.experiment) : textParam(params.experiment),
    arm: exactTags ? exactTextParam(params.arm) : textParam(params.arm),
    exactTags,
    errorOnly: booleanParam(params.errorOnly),
    sort,
    direction,
    ...(hasTraceFacetFilters(facets) ? { facets } : {}),
  };
  const cursor = parseSpanCursor(textParam(params.cursor), filters);

  return {
    range,
    filters,
    queryOptions: {
      since: range.since,
      until: range.until,
      scope: filters.scope,
      name: filters.name || undefined,
      model: filters.model || undefined,
      tool: filters.tool || undefined,
      experiment: filters.experiment || undefined,
      arm: filters.arm || undefined,
      errorOnly: filters.errorOnly,
      sort,
      direction,
      ...(cursor ? { cursor } : {}),
      ...facets,
    },
  };
}

export function resolveOperationsView(
  params: TraceListSearchParams,
  now: Date = new Date(),
): OperationsView {
  const range = resolveTraceRange(params, now);
  const requestedGroup = textParam(params.groupBy);
  const requestedSort = textParam(params.sort);
  const facets = resolveTraceFacetFilters(params);
  const filters: OperationsFilters = {
    project: textParam(params.project),
    range: range.preset,
    from: range.from,
    to: range.to,
    name: textParam(params.name),
    model: textParam(params.model),
    tool: textParam(params.tool),
    experiment: textParam(params.experiment),
    errorOnly: booleanParam(params.errorOnly),
    groupBy: OPERATION_GROUPS.has(requestedGroup) ? (requestedGroup as OperationGroupBy) : "name",
    sort: OPERATION_SORTS.has(requestedSort) ? (requestedSort as OperationSort) : "count",
    direction: textParam(params.direction) === "asc" ? "asc" : "desc",
    ...(hasTraceFacetFilters(facets) ? { facets } : {}),
  };

  return {
    range,
    filters,
    queryOptions: {
      since: range.since,
      until: range.until,
      groupBy: filters.groupBy,
      sort: filters.sort,
      direction: filters.direction,
      name: filters.name || undefined,
      model: filters.model || undefined,
      tool: filters.tool || undefined,
      experiment: filters.experiment || undefined,
      errorOnly: filters.errorOnly,
      ...facets,
    },
  };
}

export function buildTraceTabHref(pathname: string, params: TraceListSearchParams): string {
  const search = toSearchParams(params);
  search.delete("cursor");
  return href(pathname, search);
}

export function buildSpanListHref(
  pathname: string,
  params: TraceListSearchParams,
  updates: SpanListHrefUpdates = {},
  now: Date = new Date(),
): string {
  const search = toSearchParams(params);
  const filterKeys: readonly (keyof SpanListHrefUpdates)[] = [
    "project",
    "range",
    "from",
    "to",
    "scope",
    "name",
    "model",
    "tool",
    "experiment",
    "arm",
    "exactTags",
    "errorOnly",
    "sort",
    "direction",
  ];
  if (filterKeys.some((key) => Object.hasOwn(updates, key))) {
    search.delete("cursor");
  }
  for (const key of filterKeys) {
    if (!Object.hasOwn(updates, key)) continue;
    const value = updates[key];
    if (value === true) search.set(key, "1");
    else if (typeof value === "string" && value.trim()) search.set(key, value.trim());
    else search.delete(key);
  }
  if (Object.hasOwn(updates, "range") && updates.range !== "custom") {
    if (!Object.hasOwn(updates, "from")) search.delete("from");
    if (!Object.hasOwn(updates, "to")) search.delete("to");
  }
  if (Object.hasOwn(updates, "cursor")) {
    if (updates.cursor) {
      const filters = resolveSpanListView(searchParamsRecord(search), now).filters;
      search.set("cursor", serializeSpanCursor(updates.cursor, filters));
    } else {
      search.delete("cursor");
    }
  }
  return href(pathname, search);
}

export function buildOperationsHref(
  pathname: string,
  params: TraceListSearchParams,
  updates: OperationsHrefUpdates = {},
): string {
  const search = toSearchParams(params);
  search.delete("cursor");
  for (const key of ["groupBy", "sort", "direction"] as const) {
    if (!Object.hasOwn(updates, key)) continue;
    const value = updates[key];
    if (value) search.set(key, value);
    else search.delete(key);
  }
  return href(pathname, search);
}

export function serializeSpanCursor(cursor: SpanCursor, filters: SpanListFilters): string {
  if (!SPAN_CURSOR_ID_PATTERN.test(cursor.id)) {
    throw new TypeError("Invalid span cursor");
  }
  const facets = facetCursorContext(filters.facets);
  return JSON.stringify([
    facets ? 4 : 3,
    cursor.startedAt.toISOString(),
    cursor.id,
    cursor.sortValue ?? null,
    ...spanCursorContext(filters),
    ...(facets ? [facets] : []),
  ]);
}

export function parseSpanCursor(
  token: string | undefined,
  filters: SpanListFilters,
): SpanCursor | undefined {
  if (!token) return undefined;
  try {
    const payload: unknown = JSON.parse(token);
    const version = Array.isArray(payload) ? Number(payload[0]) : 0;
    const legacy = version === 1 || version === 2;
    const hasFacets = legacy ? version === 2 : version === 4;
    const context = spanCursorContext(filters);
    if (
      !Array.isArray(payload) ||
      ![1, 2, 3, 4].includes(version) ||
      payload.length !== (legacy ? (hasFacets ? 14 : 13) : hasFacets ? 17 : 16) ||
      hasFacets !== Boolean(filters.facets) ||
      typeof payload[1] !== "string" ||
      typeof payload[2] !== "string" ||
      !SPAN_CURSOR_ID_PATTERN.test(payload[2]) ||
      (legacy && (filters.sort !== "started" || filters.direction !== "desc")) ||
      (!legacy && !validCursorSortValue(payload[3], filters.sort)) ||
      JSON.stringify(payload.slice(legacy ? 3 : 4)) !==
        JSON.stringify([
          ...(legacy ? context.slice(0, -2) : context),
          ...(filters.facets ? [facetCursorContext(filters.facets)] : []),
        ])
    ) {
      return undefined;
    }
    const startedAt = new Date(payload[1]);
    if (Number.isNaN(startedAt.getTime()) || startedAt.toISOString() !== payload[1]) {
      return undefined;
    }
    return {
      startedAt,
      id: payload[2],
      ...(!legacy && typeof payload[3] === "number" ? { sortValue: payload[3] } : {}),
    };
  } catch {
    return undefined;
  }
}

export function resolveTraceCompareIds(
  params: Pick<TraceCompareSearchParams, "a" | "b">,
): readonly [string, string] | null {
  // Ingest stores trace ids lowercase, and the span lookup filters them
  // case-sensitively, so normalize before validating: an uppercase id from an
  // externally copied link must resolve to the stored row, not 404.
  const leftTraceId = textParam(params.a).toLowerCase();
  const rightTraceId = textParam(params.b).toLowerCase();
  if (!validTraceId(leftTraceId) || !validTraceId(rightTraceId) || leftTraceId === rightTraceId) {
    return null;
  }
  return [leftTraceId, rightTraceId];
}

export function serializeTraceCursor(cursor: TraceCursor, filters: TraceListFilters): string {
  const startedAt = cursor.startedAt.toISOString();
  if (!validTraceId(cursor.traceId)) {
    throw new TypeError("Invalid trace cursor");
  }
  const facets = facetCursorContext(filters.facets);
  return JSON.stringify([
    facets ? 6 : 5,
    startedAt,
    cursor.traceId,
    cursor.sortValue ?? null,
    ...cursorContext(filters),
    ...(facets ? [facets] : []),
  ]);
}

export function parseTraceCursor(
  token: string | undefined,
  filters: TraceListFilters,
): TraceCursor | undefined {
  if (!token) return undefined;
  try {
    const payload: unknown = JSON.parse(token);
    const version = Array.isArray(payload) ? Number(payload[0]) : 0;
    const legacy = version === 1 || version === 2;
    const current = version === 5 || version === 6;
    const hasFacets = version === 2 || version === 4 || version === 6;
    const context = current ? cursorContext(filters) : previousCursorContext(filters);
    if (
      !Array.isArray(payload) ||
      ![1, 2, 3, 4, 5, 6].includes(version) ||
      payload.length !==
        (current ? (hasFacets ? 18 : 17) : legacy ? (hasFacets ? 12 : 11) : hasFacets ? 15 : 14) ||
      hasFacets !== Boolean(filters.facets) ||
      (!current && Boolean(filters.name || filters.model || filters.tool)) ||
      typeof payload[1] !== "string" ||
      typeof payload[2] !== "string" ||
      !validTraceId(payload[2]) ||
      (legacy && (filters.sort !== "started" || filters.direction !== "desc")) ||
      (!legacy && !validCursorSortValue(payload[3], filters.sort)) ||
      JSON.stringify(payload.slice(legacy ? 3 : 4)) !==
        JSON.stringify([
          ...(legacy ? context.slice(0, -2) : context),
          ...(filters.facets ? [facetCursorContext(filters.facets)] : []),
        ])
    ) {
      return undefined;
    }
    const startedAt = new Date(payload[1]);
    if (Number.isNaN(startedAt.getTime()) || startedAt.toISOString() !== payload[1]) {
      return undefined;
    }
    return {
      startedAt,
      traceId: payload[2],
      ...(!legacy && typeof payload[3] === "number" ? { sortValue: payload[3] } : {}),
    };
  } catch {
    return undefined;
  }
}

export function toTraceSummaryView(summary: TraceSummary): TraceSummaryView {
  return {
    ...summary,
    startedAt: summary.startedAt.toISOString(),
    endedAt: summary.endedAt.toISOString(),
  };
}

export function toSpanSummaryView(summary: SpanSummary): SpanSummaryView {
  return { ...summary, startedAt: summary.startedAt.toISOString() };
}

export function toTraceSpanView(span: OtelSpan): TraceSpanView {
  const view: TraceSpanView & Partial<Pick<OtelSpan, "id" | "projectId" | "traceId">> = {
    ...span,
    startedAt: span.startedAt.toISOString(),
    endedAt: span.endedAt.toISOString(),
  };
  delete view.id;
  delete view.projectId;
  delete view.traceId;
  return view;
}

function textParam(value: TraceSearchParamValue): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ?? "";
}

function booleanParam(value: TraceSearchParamValue): boolean {
  return ["1", "true"].includes(textParam(value).toLowerCase());
}

function resolveRecordSort(params: Pick<TraceListSearchParams, "sort" | "direction">): {
  sort: RecordSort;
  direction: SortDirection;
} {
  const requested = textParam(params.sort);
  return {
    sort: RECORD_SORTS.has(requested) ? (requested as RecordSort) : "started",
    direction: textParam(params.direction) === "asc" ? "asc" : "desc",
  };
}

function exactTextParam(value: TraceSearchParamValue): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? "";
}

function resolveTraceFacetFilters(params: TraceListSearchParams): TraceFacetFilters {
  const duration = measureRange(params.minDurationMs, params.maxDurationMs);
  const tokens = measureRange(params.minTokens, params.maxTokens);
  const cost = measureRange(params.minCostUsd, params.maxCostUsd);
  const filters: TraceFacetFilters = {
    services: stringParams(params.facetService),
    names: stringParams(params.facetName),
    statuses: integerParams(params.facetStatus),
    kinds: integerParams(params.facetKind),
    environments: stringParams(params.facetEnvironment),
    models: stringParams(params.facetModel),
    experiments: stringParams(params.facetExperiment),
    arms: stringParams(params.facetArm),
    ...(duration.min !== undefined ? { minDurationMs: duration.min } : {}),
    ...(duration.max !== undefined ? { maxDurationMs: duration.max } : {}),
    ...(tokens.min !== undefined ? { minTokens: tokens.min } : {}),
    ...(tokens.max !== undefined ? { maxTokens: tokens.max } : {}),
    ...(cost.min !== undefined ? { minCostUsd: cost.min } : {}),
    ...(cost.max !== undefined ? { maxCostUsd: cost.max } : {}),
  };

  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as TraceFacetFilters;
}

function stringParams(value: TraceSearchParamValue): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function integerParams(value: TraceSearchParamValue): number[] {
  return stringParams(value)
    .filter((item) => /^\d+$/.test(item))
    .map(Number)
    .filter((item) => Number.isSafeInteger(item));
}

function measureRange(
  minimum: TraceSearchParamValue,
  maximum: TraceSearchParamValue,
): { min?: number; max?: number } {
  const requestedMin = nonNegativeNumberParam(minimum);
  const requestedMax = nonNegativeNumberParam(maximum);
  if (requestedMin !== undefined && requestedMax !== undefined && requestedMin > requestedMax) {
    return { min: requestedMax, max: requestedMin };
  }
  return { min: requestedMin, max: requestedMax };
}

function nonNegativeNumberParam(value: TraceSearchParamValue): number | undefined {
  const text = textParam(value);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasTraceFacetFilters(filters: TraceFacetFilters): boolean {
  return Object.keys(filters).length > 0;
}

function facetCursorContext(facets: TraceFacetFilters | undefined): string | undefined {
  return facets ? JSON.stringify(facets) : undefined;
}

function cursorContext(filters: TraceListFilters): readonly (string | number)[] {
  return [
    filters.project,
    filters.range,
    filters.from,
    filters.to,
    filters.rootName,
    filters.name,
    filters.model,
    filters.tool,
    filters.errorOnly ? 1 : 0,
    filters.experiment,
    filters.arm,
    filters.sort,
    filters.direction,
  ];
}

function previousCursorContext(filters: TraceListFilters): readonly (string | number)[] {
  return [
    filters.project,
    filters.range,
    filters.from,
    filters.to,
    filters.rootName,
    filters.errorOnly ? 1 : 0,
    filters.experiment,
    filters.arm,
    filters.sort,
    filters.direction,
  ];
}

function spanCursorContext(filters: SpanListFilters): readonly (string | number)[] {
  return [
    filters.project,
    filters.range,
    filters.from,
    filters.to,
    filters.scope,
    filters.name,
    filters.model,
    filters.tool,
    filters.experiment,
    filters.errorOnly ? 1 : 0,
    filters.sort,
    filters.direction,
  ];
}

function validCursorSortValue(value: unknown, sort: RecordSort): boolean {
  return sort === "started" ? value === null : typeof value === "number" && Number.isFinite(value);
}

function toSearchParams(params: TraceListSearchParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.set(key, value);
    else if (value !== undefined) {
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

function href(pathname: string, search: URLSearchParams): string {
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function validTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value) && !/^0+$/.test(value);
}

export function resolveTraceRange(params: TraceListSearchParams, now: Date): ResolvedRange {
  const requestedRange = textParam(params.range);
  const requestedFrom = isoDay(textParam(params.from));
  const requestedTo = isoDay(textParam(params.to));
  const hasCustomRange =
    (requestedRange === "custom" || requestedRange === "") &&
    requestedFrom !== null &&
    requestedTo !== null;
  const today = now.toISOString().slice(0, 10);
  const preset: RangePreset | "custom" = hasCustomRange
    ? "custom"
    : isRangePreset(requestedRange)
      ? requestedRange
      : DEFAULT_TRACE_RANGE;
  let from =
    preset === "custom"
      ? requestedFrom! < requestedTo!
        ? requestedFrom!
        : requestedTo!
      : presetStart(preset, today);
  const to =
    preset === "custom" ? (requestedFrom! < requestedTo! ? requestedTo! : requestedFrom!) : today;
  const requestedDayCount =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS + 1;
  if (requestedDayCount > MAX_TRACE_RANGE_DAYS) {
    from = addDays(to, -(MAX_TRACE_RANGE_DAYS - 1));
  }
  const days = daysBetween(from, to);

  return {
    preset,
    from,
    to,
    since: new Date(`${from}T00:00:00.000Z`),
    until: new Date(`${addDays(to, 1)}T00:00:00.000Z`),
    days,
    label: preset === "custom" ? `${shortDay(from)} – ${shortDay(to)}` : TRACE_RANGE_LABELS[preset],
  };
}

function isRangePreset(value: string): value is RangePreset {
  return Object.hasOwn(TRACE_RANGE_LABELS, value);
}

function presetStart(preset: RangePreset, today: string): string {
  switch (preset) {
    case "7d":
      return addDays(today, -6);
    case "14d":
      return addDays(today, -13);
    case "30d":
      return addDays(today, -29);
    case "3m":
      return addDays(addMonths(today, -3), 1);
    case "12m":
      return addDays(addMonths(today, -12), 1);
  }
}

function isoDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > MAX_TRACE_DAY) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDay));
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  })} ${date.getUTCDate()}`;
}
