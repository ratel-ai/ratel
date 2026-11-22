/**
 * One filter model for every Traces tab (DESIGN.md, Lists): the active filters
 * are chips derived from the URL, the "Add filter" popover offers the values
 * seen in the window, and every change is a new query string. The parameter
 * names are the ones v1 already writes (`errorOnly`, `facetModel`, `tool`, …),
 * so existing links, the compare flow and experiment deep links keep working.
 *
 * Pure functions over query strings, so the client bar and the tests share
 * them.
 */

import type { RangePreset } from "@/lib/synthesis/dashboard";
import { AGENT_DIMENSION_LABEL, AGENT_DIMENSIONS } from "@/lib/synthesis/traces/agent-dimensions";
import type {
  ListOperationsOptions,
  TraceFacetOptions,
  TraceFacets,
  TraceFacetValue,
} from "@/lib/synthesis/traces/queries";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { formatDuration, formatInteger, formatMoney } from "./format";

/**
 * `rollup` is the bar on Sessions and Turns
 * (RC-506): every field matches the per-trace rollup.
 */
export type TraceTab = "runs" | "spans" | "logs" | "rollup";

export type FilterFieldId =
  | "status"
  | "model"
  | "tool"
  | "service"
  | "environment"
  | "agent"
  | "server"
  | "experiment"
  | "variant"
  | "stepName"
  | "unlinked"
  | "cost"
  | "tokens";

export interface FilterChipModel {
  /** Stable key, the first parameter it reads. */
  key: string;
  /** Sentence-case lead-in: "Model is". */
  field: string;
  value: string;
  /** Parameters removing the chip deletes. */
  params: readonly string[];
}

export interface FilterOption {
  value: string;
  label: string;
  /** Matching spans in the window, when the count is in the tab's unit. */
  count?: number;
  selected: boolean;
}

export interface FilterField {
  id: FilterFieldId;
  label: string;
  options: FilterOption[];
}

/**
 * What a rollup helper needs to know about the page (RC-790). With
 * `entities` off (the default) `facetAgent` and `facetServer` are not filter
 * parameters at all: no chip, no field, no query filter, and they are not
 * removed from a query string either, exactly as before the flag.
 */
export interface TraceFilterOptions {
  /** `cloud-project-entities`: the Agent and MCP server filters exist. */
  entities?: boolean;
}

/** The rollup facets: `agent` and `server` come only with the entity filters on. */
export type TraceFilterBarFacets = Pick<TraceFacets, "model" | "tool" | "service" | "environment"> &
  Partial<Pick<TraceFacets, "experiment" | "arm" | "name">> &
  Partial<Record<"agent" | "server", readonly TraceFacetValue[]>>;

/** Never survive a filter change: the page and the open row belong to the old list. */
const VOLATILE = ["cursor", "peek"] as const;

/** The rollup bar's parameters (RC-506), besides the name search. */
const ROLLUP_FILTER_PARAMS_LIST = [
  "errorOnly",
  "status",
  "facetModel",
  "facetTool",
  "facetService",
  "facetEnvironment",
  "minCostUsd",
  "minTokens",
] as const;
export const ROLLUP_FILTER_PARAMS: readonly string[] = ROLLUP_FILTER_PARAMS_LIST;
/** The rollup bar's parameters behind `cloud-project-entities` (RC-790). */
export const ENTITY_FILTER_PARAMS = ["facetAgent", "facetServer"] as const;

/** Every parameter that narrows a list. The search box owns `name` (and `eventName` on Logs). */
const RUN_FILTER_PARAMS = [
  "name",
  "rootName",
  "errorOnly",
  "model",
  "tool",
  "conversation",
  "experiment",
  "arm",
  "exactTags",
  "facetService",
  "facetName",
  "facetStatus",
  "facetKind",
  "facetEnvironment",
  "facetModel",
  "facetExperiment",
  "facetArm",
  "minDurationMs",
  "maxDurationMs",
  "minTokens",
  "maxTokens",
  "minCostUsd",
  "maxCostUsd",
] as const;
const FILTER_PARAMS: Readonly<Record<TraceTab, readonly string[]>> = {
  runs: RUN_FILTER_PARAMS,
  // The span list has no run-name or conversation filter, and adds the top-level-only scope.
  spans: [
    ...RUN_FILTER_PARAMS.filter((param) => param !== "rootName" && param !== "conversation"),
    "scope",
    ...AGENT_DIMENSIONS,
  ],
  logs: ["name", "eventName", "experiment", "tracelessOnly"],
  rollup: ["name", ...ROLLUP_FILTER_PARAMS_LIST],
};

/** The rollup bar's thresholds: a value is the minimum it keeps. */
const COST_THRESHOLDS = [0.01, 0.1, 1] as const;
const TOKEN_THRESHOLDS = [1_000, 10_000, 100_000] as const;

const OTEL_STATUS_LABEL: Readonly<Record<string, string>> = {
  "0": "Not set",
  "1": "OK",
  "2": "Failed",
};
const OTEL_KIND_LABEL: Readonly<Record<string, string>> = {
  "0": "Unspecified",
  "1": "Internal",
  "2": "Server",
  "3": "Client",
  "4": "Producer",
  "5": "Consumer",
};

function filterParams(tab: TraceTab, options: TraceFilterOptions = {}): readonly string[] {
  return tab === "rollup" ? ["name", ...rollupParams(options)] : FILTER_PARAMS[tab];
}

function rollupParams({ entities = false }: TraceFilterOptions): readonly string[] {
  return entities
    ? [...ROLLUP_FILTER_PARAMS_LIST, ...ENTITY_FILTER_PARAMS]
    : ROLLUP_FILTER_PARAMS_LIST;
}

/** The chips for what the URL filters by. Every narrowing parameter shows up, so none hides. */
export function filterChips(
  tab: TraceTab,
  search: string,
  options: TraceFilterOptions = {},
): FilterChipModel[] {
  const params = parse(search);
  if (tab === "logs") {
    return compact([
      single(params, "experiment", "Experiment contains"),
      flag(params, "tracelessOnly", "Showing", "logs without a run"),
    ]);
  }
  if (tab === "rollup") {
    const status = rollupStatus(params);
    return compact([
      status
        ? {
            key: "status",
            field: "Status is",
            value: status === "failed" ? "Failed" : "OK",
            params: ["status", "errorOnly"],
          }
        : null,
      multi(params, "facetModel", "Model is"),
      multi(params, "facetTool", "Tool is"),
      multi(params, "facetService", "Service is"),
      multi(params, "facetEnvironment", "Environment is"),
      options.entities ? multi(params, "facetAgent", "Agent is") : null,
      options.entities ? multi(params, "facetServer", "MCP server is") : null,
      measure(params, "Cost", "minCostUsd", "maxCostUsd", (value) => formatMoney(value)),
      measure(params, "Tokens", "minTokens", "maxTokens", (value) => formatInteger(value)),
    ]);
  }
  const exact = params.get("exactTags") === "1";
  return compact([
    flag(params, "errorOnly", "Status is", "Failed"),
    tab === "runs" ? single(params, "rootName", "Run name contains") : null,
    multi(
      params,
      "facetStatus",
      tab === "runs" ? "Step status is" : "Status is",
      (value) => OTEL_STATUS_LABEL[value] ?? value,
    ),
    multi(params, "facetModel", "Model is"),
    single(params, "model", "Model contains"),
    single(params, "tool", "Tool is"),
    tab === "runs" ? single(params, "conversation", "Conversation is") : null,
    multi(params, "facetName", "Step name is"),
    multi(params, "facetService", "Service is"),
    multi(params, "facetEnvironment", "Environment is"),
    multi(params, "facetExperiment", "Experiment is"),
    single(params, "experiment", exact ? "Experiment is" : "Experiment contains"),
    multi(params, "facetArm", "Variant is"),
    single(params, "arm", exact ? "Variant is" : "Variant contains"),
    multi(params, "facetKind", "Span kind is", (value) => OTEL_KIND_LABEL[value] ?? value),
    measure(params, "Duration", "minDurationMs", "maxDurationMs", (value) => formatDuration(value)),
    measure(params, "Tokens", "minTokens", "maxTokens", (value) => formatInteger(value)),
    measure(params, "Cost", "minCostUsd", "maxCostUsd", (value) => formatMoney(value)),
    tab === "spans" && params.get("scope") === "root"
      ? { key: "scope", field: "Showing", value: "top-level steps only", params: ["scope"] }
      : null,
    // AOBS-5: a group's row on Spans drills down to its exact value.
    ...(tab === "spans"
      ? AGENT_DIMENSIONS.map((dimension) =>
          single(params, dimension, `${AGENT_DIMENSION_LABEL[dimension]} is`),
        )
      : []),
  ]);
}

/** The query string without one chip. Removing the last experiment or variant drops `exactTags` too. */
export function withoutChip(search: string, chip: Pick<FilterChipModel, "params">): string {
  const params = parse(search);
  for (const name of chip.params) params.delete(name);
  if (!params.get("experiment") && !params.get("arm")) params.delete("exactTags");
  return withoutVolatile(params);
}

export function hasFilters(
  tab: TraceTab,
  search: string,
  options: TraceFilterOptions = {},
): boolean {
  const params = parse(search);
  return filterParams(tab, options).some(
    (name) => name !== "exactTags" && params.getAll(name).some((value) => value.trim()),
  );
}

/** Every filter off; the window, sort, view options and selection stay. */
export function withoutFilters(
  tab: TraceTab,
  search: string,
  options: TraceFilterOptions = {},
): string {
  const params = parse(search);
  for (const name of filterParams(tab, options)) params.delete(name);
  return withoutVolatile(params);
}

/** What the search box shows: the name filter (an event name on Logs). */
export function searchText(tab: TraceTab, search: string): string {
  const params = parse(search);
  return (params.get("name") ?? (tab === "logs" ? params.get("eventName") : null) ?? "").trim();
}

export function withSearchText(tab: TraceTab, search: string, text: string): string {
  const params = parse(search);
  const value = text.trim();
  if (value) params.set("name", value);
  else params.delete("name");
  if (tab === "logs") params.delete("eventName");
  return withoutVolatile(params);
}

/**
 * The fields the "Add filter" popover offers, with the values seen in the
 * window. Fields with nothing to pick are left out; Status is always there.
 * Counts are span counts, so only the Spans tab shows them.
 */
export function filterFields(
  tab: TraceTab,
  search: string,
  facets: TraceFilterBarFacets,
  options: TraceFilterOptions = {},
): FilterField[] {
  const params = parse(search);
  if (tab === "rollup") {
    const status = rollupStatus(params);
    const minCost = params.get("minCostUsd")?.trim();
    const minTokens = params.get("minTokens")?.trim();
    return compactFields([
      {
        id: "status",
        label: "Status",
        options: [
          { value: "failed", label: "Failed", selected: status === "failed" },
          { value: "ok", label: "OK", selected: status === "ok" },
        ],
      },
      field("model", "Model", facets.model, new Set(params.getAll("facetModel")), true),
      field("tool", "Tool", facets.tool, new Set(params.getAll("facetTool")), true),
      field("service", "Service", facets.service, new Set(params.getAll("facetService")), true),
      field(
        "environment",
        "Environment",
        facets.environment,
        new Set(params.getAll("facetEnvironment")),
        true,
      ),
      options.entities
        ? field("agent", "Agent", facets.agent ?? [], new Set(params.getAll("facetAgent")), true)
        : null,
      options.entities
        ? field(
            "server",
            "MCP server",
            facets.server ?? [],
            new Set(params.getAll("facetServer")),
            true,
          )
        : null,
      {
        id: "cost",
        label: "Cost",
        options: COST_THRESHOLDS.map((value) => ({
          value: String(value),
          label: `Over ${formatMoney(value)}`,
          selected: minCost === String(value),
        })),
      },
      {
        id: "tokens",
        label: "Tokens",
        options: TOKEN_THRESHOLDS.map((value) => ({
          value: String(value),
          label: `Over ${formatInteger(value)}`,
          selected: minTokens === String(value),
        })),
      },
    ]);
  }
  const withCounts = tab === "spans";
  if (tab === "logs") {
    return compactFields([
      field(
        "experiment",
        "Experiment",
        facets.experiment ?? [],
        singleSelected(params, "experiment"),
        false,
      ),
      {
        id: "unlinked",
        label: "Run",
        options: [
          {
            value: "1",
            label: "Logs without a run",
            selected: params.get("tracelessOnly") === "1",
          },
        ],
      },
    ]);
  }
  return compactFields([
    {
      id: "status",
      label: "Status",
      options: [{ value: "failed", label: "Failed", selected: isOn(params.get("errorOnly")) }],
    },
    field("model", "Model", facets.model, new Set(params.getAll("facetModel")), withCounts),
    field("tool", "Tool", facets.tool, singleSelected(params, "tool"), withCounts),
    tab === "spans"
      ? field(
          "stepName",
          "Step name",
          facets.name ?? [],
          new Set(params.getAll("facetName")),
          withCounts,
        )
      : null,
    field("service", "Service", facets.service, new Set(params.getAll("facetService")), withCounts),
    field(
      "environment",
      "Environment",
      facets.environment,
      new Set(params.getAll("facetEnvironment")),
      withCounts,
    ),
    field(
      "experiment",
      "Experiment",
      facets.experiment ?? [],
      new Set(params.getAll("facetExperiment")),
      withCounts,
    ),
    field("variant", "Variant", facets.arm ?? [], new Set(params.getAll("facetArm")), withCounts),
  ]);
}

/** Toggle one value of a field: multi-value facets add or remove it, single ones replace it. */
export function withFilterToggled(
  tab: TraceTab,
  search: string,
  fieldId: FilterFieldId,
  value: string,
): string {
  const params = parse(search);
  if (tab === "rollup") {
    toggleRollup(params, fieldId, value);
    return withoutVolatile(params);
  }
  switch (fieldId) {
    case "status":
      toggleFlag(params, "errorOnly");
      break;
    case "unlinked":
      toggleFlag(params, "tracelessOnly");
      break;
    case "tool":
      toggleSingle(params, "tool", value);
      break;
    case "experiment":
      if (tab === "logs") toggleSingle(params, "experiment", value);
      else toggleMulti(params, "facetExperiment", value);
      break;
    case "model":
      toggleMulti(params, "facetModel", value);
      break;
    case "service":
      toggleMulti(params, "facetService", value);
      break;
    case "environment":
      toggleMulti(params, "facetEnvironment", value);
      break;
    case "variant":
      toggleMulti(params, "facetArm", value);
      break;
    case "stepName":
      toggleMulti(params, "facetName", value);
      break;
  }
  return withoutVolatile(params);
}

/**
 * The Sessions and Turns property filters in the URL (RC-505), as the
 * rollup query reads them. Status reads
 * `errorOnly` (what v1 links write) or `status=ok|failed`. `facetAgent` and
 * `facetServer` are read only with `entities` on (RC-790).
 */
export function traceFilterFromSearch(
  search: string,
  options: TraceFilterOptions = {},
): TraceFilter {
  const params = parse(search);
  const values = (name: string) => [
    ...new Set(
      params
        .getAll(name)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const status = rollupStatus(params) ?? undefined;
  const minCostUsd = numberParam(params.get("minCostUsd"));
  const minTokens = numberParam(params.get("minTokens"));
  const filter: TraceFilter = {
    models: values("facetModel"),
    tools: values("facetTool"),
    services: values("facetService"),
    environments: values("facetEnvironment"),
    agents: options.entities ? values("facetAgent") : undefined,
    mcpServers: options.entities ? values("facetServer") : undefined,
    status,
    minCostUsd: minCostUsd ?? undefined,
    minTokens: minTokens ?? undefined,
  };
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  ) as TraceFilter;
}

/** Only the rollup bar's parameters of a query string, for a request that pages the same list. */
export function rollupFilterQuery(
  search: string,
  options: TraceFilterOptions = {},
): URLSearchParams {
  const params = parse(search);
  const kept = new URLSearchParams();
  for (const name of rollupParams(options))
    for (const value of params.getAll(name)) kept.append(name, value);
  return kept;
}

/** A query string without the rollup bar's parameters, so the span-scan filters never also read them. */
export function withoutRollupFilters(search: string, options: TraceFilterOptions = {}): string {
  const params = parse(search);
  for (const name of rollupParams(options)) params.delete(name);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** A preset time window replaces a custom one and its days. */
export function withRangePreset(search: string, preset: RangePreset): string {
  const params = parse(search);
  params.set("range", preset);
  params.delete("from");
  params.delete("to");
  return withoutVolatile(params);
}

/** Switching tabs keeps the window and the filters; the page and the open row stay behind. */
export function tabSearch(search: string): string {
  return withoutVolatile(parse(search));
}

/** A server page's search params as a query string, so the server and the client share the helpers above. */
export function searchFromParams(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.append(key, value);
    else if (value) for (const item of value) search.append(key, item);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * v2 folds the Operations tab into Spans as "Group by". An old Operations link
 * keeps working: it lands on Spans grouped the way it was (by name when it
 * didn't say), with its window, filters and sort.
 */
export function operationsAsSpansSearch(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const search = new URLSearchParams(searchFromParams(params).slice(1));
  const groupBy = search.get("groupBy");
  if (groupBy !== "name" && groupBy !== "model" && groupBy !== "tool")
    search.set("groupBy", "name");
  search.delete("cursor");
  return `?${search.toString()}`;
}

/**
 * Grouped Spans read the operations aggregate under every filter the span
 * list applies. The operations view alone drops the variant and the
 * top-level scope (and reads experiment and variant without `exactTags`), so
 * their chips would show a filter that did nothing.
 */
export function groupedSpanOptions(
  grouped: ListOperationsOptions,
  list: Pick<TraceFacetOptions, "scope" | "experiment" | "arm">,
): ListOperationsOptions {
  return { ...grouped, scope: list.scope, experiment: list.experiment, arm: list.arm };
}

/** The first value of a repeatable search param. */
export function firstParam(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** A sort header's link: the new order starts from the first page. */
export function withSort(search: string, sort: string, direction: "asc" | "desc"): string {
  const params = parse(search);
  params.set("sort", sort);
  params.set("direction", direction);
  return withoutVolatile(params);
}

/** A list's first page: the cursor goes, everything else stays. */
export function withoutCursor(search: string): string {
  return withoutVolatile(parse(search));
}

/** The next page: the server's cursor on the live query (view state like the compare pick stays). */
export function withCursor(search: string, cursor: string): string {
  const params = parse(search);
  params.delete("peek");
  params.set("cursor", cursor);
  return `?${params.toString()}`;
}

const PRESET_ORDER: readonly RangePreset[] = ["7d", "14d", "30d", "3m", "12m"];

/**
 * The narrowest preset window that reaches back to `latestAt`, to offer when
 * nothing falls in the current one. Null when none does, or the current
 * preset already reaches it.
 */
export function presetCovering(
  latestAt: string | null,
  current: RangePreset | "custom",
  presetStart: (preset: RangePreset) => string,
): RangePreset | null {
  if (!latestAt) return null;
  const day = latestAt.slice(0, 10);
  const covering = PRESET_ORDER.find((preset) => day >= presetStart(preset)) ?? null;
  if (!covering || covering === current) return null;
  if (current !== "custom" && PRESET_ORDER.indexOf(covering) <= PRESET_ORDER.indexOf(current))
    return null;
  return covering;
}

/**
 * Set one view parameter the server never reads (a shown column) and change
 * nothing else: the page and the open row stay, since nothing reloads.
 */
export function withViewParam(search: string, name: string, value: string | null): string {
  const params = parse(search);
  if (value === null || value === "") params.delete(name);
  else params.set(name, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function parse(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function withoutVolatile(params: URLSearchParams): string {
  for (const name of VOLATILE) params.delete(name);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function isOn(value: string | null): boolean {
  return value !== null && ["1", "true"].includes(value.trim().toLowerCase());
}

function flag(
  params: URLSearchParams,
  name: string,
  field: string,
  value: string,
): FilterChipModel | null {
  return isOn(params.get(name)) ? { key: name, field, value, params: [name] } : null;
}

function single(params: URLSearchParams, name: string, field: string): FilterChipModel | null {
  const value = params.get(name)?.trim();
  return value ? { key: name, field, value, params: [name] } : null;
}

function multi(
  params: URLSearchParams,
  name: string,
  field: string,
  label: (value: string) => string = (value) => value,
): FilterChipModel | null {
  const values = [
    ...new Set(
      params
        .getAll(name)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length > 0
    ? { key: name, field, value: values.map(label).join(", "), params: [name] }
    : null;
}

function measure(
  params: URLSearchParams,
  field: string,
  minName: string,
  maxName: string,
  format: (value: number) => string,
): FilterChipModel | null {
  const min = numberParam(params.get(minName));
  const max = numberParam(params.get(maxName));
  if (min === null && max === null) return null;
  const value =
    min !== null && max !== null
      ? `${format(Math.min(min, max))} to ${format(Math.max(min, max))}`
      : min !== null
        ? `over ${format(min)}`
        : `under ${format(max!)}`;
  return { key: minName, field, value, params: [minName, maxName] };
}

function numberParam(value: string | null): number | null {
  if (value === null || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function singleSelected(params: URLSearchParams, name: string): ReadonlySet<string> {
  const value = params.get(name)?.trim();
  return new Set(value ? [value] : []);
}

function field(
  id: FilterFieldId,
  label: string,
  values: readonly TraceFacetValue[],
  selected: ReadonlySet<string>,
  withCounts: boolean,
): FilterField {
  const options = values.map((item) => ({
    value: item.value,
    label: item.value,
    ...(withCounts ? { count: item.count } : {}),
    selected: selected.has(item.value),
  }));
  // A selected value can filter its own facet to nothing; keep it pickable.
  for (const value of selected) {
    if (!options.some((option) => option.value === value))
      options.unshift({ value, label: value, selected: true });
  }
  return { id, label, options };
}

function compact<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

function compactFields(fields: readonly (FilterField | null)[]): FilterField[] {
  return compact(fields).filter((item) => item.options.length > 0);
}

const ROLLUP_MULTI: Partial<Record<FilterFieldId, string>> = {
  model: "facetModel",
  tool: "facetTool",
  service: "facetService",
  environment: "facetEnvironment",
  // Offered only with `cloud-project-entities` on, so a toggle never comes without it.
  agent: "facetAgent",
  server: "facetServer",
};

function toggleRollup(params: URLSearchParams, fieldId: FilterFieldId, value: string): void {
  const multiParam = ROLLUP_MULTI[fieldId];
  if (multiParam) return toggleMulti(params, multiParam, value);
  if (fieldId === "cost") return toggleSingle(params, "minCostUsd", value);
  if (fieldId === "tokens") return toggleSingle(params, "minTokens", value);
  if (fieldId === "status") {
    const current = rollupStatus(params);
    params.delete("errorOnly");
    params.delete("status");
    if (current !== value) params.set("status", value);
  }
}

/** The rollup bar's status: `status=ok|failed`, or `errorOnly` from v1 links. */
function rollupStatus(params: URLSearchParams): "failed" | "ok" | null {
  if (isOn(params.get("errorOnly"))) return "failed";
  const status = params.get("status");
  return status === "failed" || status === "ok" ? status : null;
}

function toggleFlag(params: URLSearchParams, name: string): void {
  if (isOn(params.get(name))) params.delete(name);
  else params.set(name, "1");
}

function toggleSingle(params: URLSearchParams, name: string, value: string): void {
  if (params.get(name)?.trim() === value) params.delete(name);
  else params.set(name, value);
}

function toggleMulti(params: URLSearchParams, name: string, value: string): void {
  const values = params.getAll(name);
  params.delete(name);
  const next = values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
  for (const item of next) params.append(name, item);
}
