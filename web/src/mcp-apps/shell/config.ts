/**
 * What a binding tells a generic view (list, detail, series): where the rows
 * are in the result, which columns and fields to show, and how to format them.
 *
 * Bindings are authored in TypeScript (views/<view>/bindings.ts), so the types
 * catch most mistakes; the parsers below catch the rest at runtime with a
 * message that names the binding and the path, instead of a blank view. No zod:
 * every byte counts against the view budget.
 */
import type { Tone } from "@ratel/design-system/badge";
import type { Noun } from "@ratel/design-system/entity";

/**
 * Six are console cells, as the console's own tables draw them: status
 * (StatusDot, the runs table), relative (RelativeTime), tools (ToolBadges),
 * taskStatus (TaskStatusBadge, the tasks table), meter (a 0 to 1 share as the
 * intents table's DotMeter) and sentiment (SentimentBar).
 *
 * The last four print a number as the console page for that entity prints it,
 * through the page's own formatter, so a view and the page never round apart:
 * share (a 0 to 1 share on the task pages: "9%", "<1%", ">99%"), whole (a 0 to
 * 1 share on the intent pages: a whole percent), per100 (the task pages' "per
 * 100 runs"), taskCost (a task's cost per run: "~$0.12" when estimated,
 * "Not priced") and points (what fixing an issue wins back on the Health
 * score: "+7 pts", a dash under one point, as Agent health's table).
 */
export const CELL_FORMATS = [
  "text",
  "number",
  "currency",
  "duration",
  "date",
  "percent",
  "badge",
  "entity",
  "bar",
  "id",
  "status",
  "relative",
  "tools",
  "taskStatus",
  "meter",
  "sentiment",
  "share",
  "whole",
  "per100",
  "taskCost",
  "points",
] as const;
export type CellFormat = (typeof CELL_FORMATS)[number];

export interface FieldConfig {
  /** Dot path into the row or object: "costUsd", "sentiment.negativeShare". */
  key: string;
  label: string;
  format?: CellFormat;
  /** badge: the tone for each value, and optionally its label. */
  tones?: Record<string, Tone>;
  labels?: Record<string, string>;
  /** entity: which noun's pin. */
  noun?: Noun;
  /** bar: how the number next to the bar reads; "percent" for a 0 to 1 share. */
  unit?: "number" | "percent";
  /** text that people wrote (asks, messages): shown as redacted when withheld. */
  content?: boolean;
  /** Read this path when `key` has no value (a run's title: its ask, else its root span). */
  orKey?: string;
  /** meter: a row flag that marks the share as a warning, as "mostly unanswered" does. */
  warnKey?: string;
}

export interface ColumnConfig extends FieldConfig {
  align?: "left" | "right";
  width?: string;
  /** Sortable on the client. Default true. */
  sortable?: boolean;
  hiddenBelow?: "sm" | "md" | "lg";
  /** Left out when no row has a value (a run's tools come only with includeDetails). */
  optional?: boolean;
}

export interface FilterConfig {
  key: string;
  label: string;
  /** "values": a chip per distinct value of the key. "flag": on when the value is truthy. */
  kind: "values" | "flag";
  badgeLabels?: Record<string, string>;
}

export interface ListConfig {
  /** Dot path to the array of rows in `data`. */
  rows: string;
  rowKey: string;
  /** The title column, also the Panel's title. */
  title: string;
  noun: { one: string; many: string };
  columns: ColumnConfig[];
  /** Keys the search box matches against. */
  search?: string[];
  filters?: FilterConfig[];
  defaultSort?: { key: string; direction: "asc" | "desc" };
  /**
   * The tool's own `sort` argument: for each of its values, the column it
   * orders by, so that column's header shows it. A value with no column of its
   * own (skills by runs) is left out. See `initialSort`.
   */
  sortArg?: Record<string, { key: string; direction: "asc" | "desc" }>;
  /** Opening a row calls this tool and shows its result as the detail binding does. */
  detail?: { tool: string; args: Record<string, string> };
  /** Paging: where the next cursor is in `data`, and the argument that takes it. */
  cursor?: { next: string; param: string };
  empty?: { title: string; description?: string };
  /**
   * Draw the list from the tool's view model (the result's `_meta`) instead of
   * its data, when the result carries one of this `kind`: `rows` is then a path
   * into the view model, and these fields stand in for the config's (a field
   * left out is not inherited, so the list has no detail, paging or sort of its
   * own unless it says so here). For a tool whose data is not what its console
   * page lists: list_insights returns every issue, the page one row per kind.
   * Without the view model (a host that passes none) the list is the config's.
   */
  fromView?: { kind: string } & Pick<ListConfig, "rows" | "rowKey" | "title" | "columns"> &
    Partial<Pick<ListConfig, "noun" | "search" | "filters" | "defaultSort" | "empty">>;
}

export interface DetailSection {
  title: string;
  /** fields: key/value pairs from `key` (an object); table: rows from `key` (an array); list: strings. */
  kind: "fields" | "table" | "list";
  key: string;
  fields?: FieldConfig[];
  columns?: ColumnConfig[];
}

export interface DetailConfig {
  /** Dot path to the entity object in `data`; "" for `data` itself. */
  root: string;
  title: string;
  subtitle?: string;
  noun?: Noun;
  /** A console path template for "Open in Ratel": "/projects/{projectId}/traces/{traceId}". */
  consolePath?: string;
  /** Or the dot path of a console path the result carries ("intent.href"). */
  href?: string;
  fields: FieldConfig[];
  sections?: DetailSection[];
}

export const SERIES_AGGREGATES = ["sum", "avg", "max", "last", "window"] as const;

export interface SeriesStat {
  label: string;
  /** A row key; with aggregate "window", a dot path into `data` instead. */
  key: string;
  /**
   * How the rows make the number. "window" reads the tool's own figure for the
   * whole window (`data.kpis.p95LatencyMs`) as is: a percentile does not
   * aggregate from daily rows, and it is there even when the rows are not.
   */
  aggregate: (typeof SERIES_AGGREGATES)[number];
  format?: CellFormat;
}

export interface SeriesConfig {
  rows: string;
  /** The day ("2026-11-03") or timestamp of each point. */
  x: string;
  measure: { key: string; label: string; format?: CellFormat };
  stats: SeriesStat[];
  /** What the chart says when there are no rows. */
  empty?: { title: string; description?: string };
}

export class BindingConfigError extends Error {
  constructor(tool: string, path: string, problem: string) {
    super(`Binding for ${tool}: ${path} ${problem}`);
    this.name = "BindingConfigError";
  }
}

type Raw = Record<string, unknown>;

function object(tool: string, path: string, value: unknown): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BindingConfigError(tool, path, "must be an object");
  return value as Raw;
}

function string(tool: string, path: string, value: unknown, optional = false): string {
  if (value === undefined && optional) return undefined as unknown as string;
  if (typeof value !== "string" || value.length === 0)
    throw new BindingConfigError(tool, path, "must be a non-empty string");
  return value;
}

function array(tool: string, path: string, value: unknown, optional = false): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new BindingConfigError(tool, path, "must be an array");
  return value;
}

function oneOf<T extends string>(
  tool: string,
  path: string,
  value: unknown,
  allowed: readonly T[],
  optional = false,
): T {
  if (value === undefined && optional) return undefined as unknown as T;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BindingConfigError(tool, path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function field<T extends FieldConfig>(tool: string, path: string, value: unknown): T {
  const raw = object(tool, path, value);
  string(tool, `${path}.key`, raw.key);
  string(tool, `${path}.label`, raw.label);
  oneOf(tool, `${path}.format`, raw.format, CELL_FORMATS, true);
  if (raw.format === "entity" && raw.noun === undefined)
    throw new BindingConfigError(tool, `${path}.noun`, "is required for an entity cell");
  if (raw.format === "status" && raw.tones === undefined)
    throw new BindingConfigError(tool, `${path}.tones`, "is required for a status cell");
  if (raw.orKey !== undefined) string(tool, `${path}.orKey`, raw.orKey);
  if (raw.warnKey !== undefined) string(tool, `${path}.warnKey`, raw.warnKey);
  if (raw.align !== undefined) oneOf(tool, `${path}.align`, raw.align, ["left", "right"]);
  return raw as unknown as T;
}

export function parseListConfig(tool: string, config: unknown): ListConfig {
  const raw = object(tool, "config", config);
  string(tool, "config.rows", raw.rows);
  string(tool, "config.rowKey", raw.rowKey);
  string(tool, "config.title", raw.title);
  const noun = object(tool, "config.noun", raw.noun);
  string(tool, "config.noun.one", noun.one);
  string(tool, "config.noun.many", noun.many);
  const columns = array(tool, "config.columns", raw.columns);
  if (columns.length === 0)
    throw new BindingConfigError(tool, "config.columns", "needs at least one column");
  columns.forEach((column, index) => field(tool, `config.columns[${index}]`, column));
  array(tool, "config.search", raw.search, true).forEach((key, index) =>
    string(tool, `config.search[${index}]`, key),
  );
  array(tool, "config.filters", raw.filters, true).forEach((filter, index) => {
    const value = object(tool, `config.filters[${index}]`, filter);
    string(tool, `config.filters[${index}].key`, value.key);
    string(tool, `config.filters[${index}].label`, value.label);
    oneOf(tool, `config.filters[${index}].kind`, value.kind, ["values", "flag"]);
  });
  if (raw.defaultSort !== undefined) {
    const sort = object(tool, "config.defaultSort", raw.defaultSort);
    string(tool, "config.defaultSort.key", sort.key);
    oneOf(tool, "config.defaultSort.direction", sort.direction, ["asc", "desc"]);
  }
  if (raw.sortArg !== undefined) {
    for (const [value, column] of Object.entries(object(tool, "config.sortArg", raw.sortArg))) {
      const sort = object(tool, `config.sortArg.${value}`, column);
      string(tool, `config.sortArg.${value}.key`, sort.key);
      oneOf(tool, `config.sortArg.${value}.direction`, sort.direction, ["asc", "desc"]);
    }
  }
  if (raw.detail !== undefined) {
    const detail = object(tool, "config.detail", raw.detail);
    string(tool, "config.detail.tool", detail.tool);
    const args = object(tool, "config.detail.args", detail.args);
    for (const [name, key] of Object.entries(args)) string(tool, `config.detail.args.${name}`, key);
  }
  if (raw.cursor !== undefined) {
    const cursor = object(tool, "config.cursor", raw.cursor);
    string(tool, "config.cursor.next", cursor.next);
    string(tool, "config.cursor.param", cursor.param);
  }
  if (raw.fromView !== undefined) {
    const fromView = object(tool, "config.fromView", raw.fromView);
    string(tool, "config.fromView.kind", fromView.kind);
    // The same rules as the config it stands in for.
    parseListConfig(`${tool} (fromView)`, viewConfig(raw as unknown as ListConfig));
  }
  return raw as unknown as ListConfig;
}

/** The config a list drawn from the view model uses: `fromView`'s fields, the binding's noun and empty words where it has none. */
function viewConfig(config: ListConfig): ListConfig {
  const { kind: _kind, ...fields } = config.fromView!;
  return { noun: config.noun, empty: config.empty, ...fields };
}

/**
 * Where a list's rows come from: the tool's view model when the binding names
 * one and the result carries it, else the tool's data.
 */
export function listSource(
  config: ListConfig,
  result: { data: unknown; view?: Record<string, unknown> },
): { config: ListConfig; source: unknown } {
  if (config.fromView && result.view?.kind === config.fromView.kind)
    return { config: viewConfig(config), source: result.view };
  return { config, source: result.data };
}

export function parseDetailConfig(tool: string, config: unknown): DetailConfig {
  const raw = object(tool, "config", config);
  if (typeof raw.root !== "string")
    throw new BindingConfigError(tool, "config.root", 'must be a string ("" for data itself)');
  string(tool, "config.title", raw.title);
  string(tool, "config.subtitle", raw.subtitle, true);
  string(tool, "config.consolePath", raw.consolePath, true);
  string(tool, "config.href", raw.href, true);
  array(tool, "config.fields", raw.fields).forEach((value, index) =>
    field(tool, `config.fields[${index}]`, value),
  );
  array(tool, "config.sections", raw.sections, true).forEach((value, index) => {
    const section = object(tool, `config.sections[${index}]`, value);
    string(tool, `config.sections[${index}].title`, section.title);
    string(tool, `config.sections[${index}].key`, section.key);
    const kind = oneOf(tool, `config.sections[${index}].kind`, section.kind, [
      "fields",
      "table",
      "list",
    ]);
    if (kind === "fields")
      array(tool, `config.sections[${index}].fields`, section.fields).forEach((item, at) =>
        field(tool, `config.sections[${index}].fields[${at}]`, item),
      );
    if (kind === "table")
      array(tool, `config.sections[${index}].columns`, section.columns).forEach((item, at) =>
        field(tool, `config.sections[${index}].columns[${at}]`, item),
      );
  });
  return raw as unknown as DetailConfig;
}

export function parseSeriesConfig(tool: string, config: unknown): SeriesConfig {
  const raw = object(tool, "config", config);
  string(tool, "config.rows", raw.rows);
  string(tool, "config.x", raw.x);
  field(tool, "config.measure", raw.measure);
  const stats = array(tool, "config.stats", raw.stats);
  if (stats.length < 2 || stats.length > 5)
    throw new BindingConfigError(tool, "config.stats", "needs 2 to 5 stats (DESIGN.md, StatRow)");
  stats.forEach((value, index) => {
    const stat = field<FieldConfig & { aggregate: unknown }>(tool, `config.stats[${index}]`, value);
    oneOf(tool, `config.stats[${index}].aggregate`, stat.aggregate, SERIES_AGGREGATES);
  });
  return raw as unknown as SeriesConfig;
}

export interface ListOrder {
  /** The column whose header reads as sorted, if any. */
  sort: { id: string; direction: "asc" | "desc" } | undefined;
  /** The rows stay as the tool returned them; the view does not sort them again. */
  serverOrder: boolean;
}

/**
 * How a list starts. When the call named a `sort`, the tool ordered the whole
 * set and returned its first page: the view keeps that order (sorting the page
 * again by another column would show the slowest runs newest first) and marks
 * the column the sort is about. Otherwise the binding's default sort applies,
 * as before. Sorting by a header afterwards is the view's own, over the rows
 * it has.
 */
export function initialSort(
  config: Pick<ListConfig, "defaultSort" | "sortArg">,
  input: Record<string, unknown> | null,
): ListOrder {
  const asked = typeof input?.sort === "string" && input.sort !== "" ? input.sort : null;
  if (asked === null) {
    return {
      sort: config.defaultSort
        ? { id: config.defaultSort.key, direction: config.defaultSort.direction }
        : undefined,
      serverOrder: false,
    };
  }
  const column = config.sortArg?.[asked];
  const direction =
    input?.direction === "asc" || input?.direction === "desc" ? input.direction : column?.direction;
  return {
    sort: column && direction ? { id: column.key, direction } : undefined,
    serverOrder: true,
  };
}

/** A value at a dot path; "" is the object itself. */
export function getPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Raw)[part];
  }
  return current;
}

/** "/projects/{projectId}/x/{id}" filled from the object; null when a value is missing. */
export function fillTemplate(template: string, ...sources: unknown[]): string | null {
  let missing = false;
  const filled = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    for (const source of sources) {
      const value = getPath(source, key);
      if (typeof value === "string" || typeof value === "number")
        return encodeURIComponent(String(value));
    }
    missing = true;
    return "";
  });
  return missing ? null : filled;
}

/** A detail tool's arguments for a row (the project comes from the bridge: state.ts withProject). Missing ones are left out. */
export function detailArgs(args: Record<string, string>, row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(args)) {
    const value = getPath(row, path);
    if (value !== undefined && value !== null && value !== "") out[name] = value;
  }
  return out;
}
