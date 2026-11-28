import type { BinaryOp, UnaryOp } from "./ast";
import type { RqlTable } from "./catalog";
import type { CheckedExpr, CheckedSelect, ParamType, ParamValue } from "./check";
import { pageFilterConditions, type RqlPageFilter } from "./page-filter";
import type { RqlWindow } from "./window";

/**
 * The rewrite: prints Postgres SQL from the checked tree. Each name in the SQL comes from the
 * catalog, each value is a bound parameter, and each output column is `cN`. No text of the query
 * reaches the SQL.
 */

export interface RewrittenSql {
  sql: string;
  params: ParamValue[];
  /** The index in `params` of the LIMIT. No literal shares it, so a runner may change it alone. */
  limitParam: number;
}

export const RQL_SCHEMA = "rql";
/** The origin of `time_bucket`: a Monday at midnight UTC, so a day starts at midnight and a week on Monday. */
const BUCKET_ORIGIN = "timestamptz '2000-01-03 00:00:00+00'";

const BINARY_SQL: Readonly<Record<BinaryOp, string>> = {
  AND: "and",
  OR: "or",
  "=": "=",
  "!=": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  LIKE: "like",
  "NOT LIKE": "not like",
  ILIKE: "ilike",
  "NOT ILIKE": "not ilike",
};

const POSTFIX_SQL: Readonly<Partial<Record<UnaryOp, string>>> = {
  "IS NULL": "is null",
  "IS NOT NULL": "is not null",
  "IS TRUE": "is true",
  "IS NOT TRUE": "is not true",
  "IS FALSE": "is false",
  "IS NOT FALSE": "is not false",
};

/**
 * The SQL of a checked select in a window, with `limit` rows at most. The window bounds are
 * always `$1` and `$2`; an equal value with an equal type is one parameter, except the LIMIT,
 * which is always a parameter of its own.
 */
export function rewriteSelect(
  select: CheckedSelect,
  window: RqlWindow,
  limit: number,
  filter: RqlPageFilter = {},
): RewrittenSql {
  const params = new Params();
  const scope = [
    windowCondition(select.table, params, window),
    ...pageFilterCondition(select.table, params, filter),
  ];
  const windowSql = scope.join(" and ");
  const print = (expr: CheckedExpr) => printExpr(expr, params);

  const items = select.items.map((item, i) => `${print(item.expr)} as ${outputName(i)}`);
  const parts = [`select ${select.distinct ? "distinct " : ""}${items.join(", ")}`];
  if (select.table.grain === "rows") {
    parts.push(`from ${view(select.table)}`);
    parts.push(`where ${windowSql}${select.where ? ` and ${print(select.where)}` : ""}`);
  } else {
    parts.push(`from (${totalsQuery(select.table, windowSql)}) as ${quote(select.table.name)}`);
    if (select.where) parts.push(`where ${print(select.where)}`);
  }
  if (select.groupBy.length > 0) parts.push(`group by ${select.groupBy.map(print).join(", ")}`);
  if (select.having) parts.push(`having ${print(select.having)}`);
  if (select.orderBy.length > 0) {
    const keys = select.orderBy.map(
      (order) =>
        `${print(order.expr)}${order.direction ? ` ${order.direction}` : ""}${order.nulls ? ` nulls ${order.nulls}` : ""}`,
    );
    parts.push(`order by ${keys.join(", ")}`);
  }
  const limitParam = params.addOwn(limit, "bigint");
  parts.push(`limit ${limitParam.placeholder}`);
  return { sql: parts.join(" "), params: params.values, limitParam: limitParam.index };
}

/** The bound parameters of one query. */
class Params {
  readonly values: ParamValue[] = [];
  private readonly placeholders = new Map<string, string>();

  add(value: ParamValue, type: ParamType): string {
    const key = `${type}:${typeof value}:${String(value)}`;
    const known = this.placeholders.get(key);
    if (known) return known;
    const { placeholder } = this.addOwn(value, type);
    this.placeholders.set(key, placeholder);
    return placeholder;
  }

  /** A parameter no other value shares, and its index in `values`. */
  addOwn(value: ParamValue, type: ParamType): { placeholder: string; index: number } {
    this.values.push(value);
    return { placeholder: `$${this.values.length}::${type}`, index: this.values.length - 1 };
  }
}

function windowCondition(table: RqlTable, params: Params, window: RqlWindow): string {
  const column = quote(table.timeColumn);
  const from = params.add(window.from.toISOString(), "timestamptz");
  const to = params.add(window.to.toISOString(), "timestamptz");
  return `${column} >= ${from} and ${column} < ${to}`;
}

/**
 * The page filter on a table: on `traces` its own columns; on the other tables the trace of each
 * row (`trace_id`), so every part applies everywhere, as the metric form filters on the trace's
 * summary. On `sessions` and `users` it narrows the trace rows before their totals.
 */
function pageFilterCondition(table: RqlTable, params: Params, filter: RqlPageFilter): string[] {
  const param = (value: string | number) =>
    typeof value === "number" ? params.add(value, "double precision") : params.add(value, "text");
  const conditions = pageFilterConditions(filter, param);
  if (conditions.length === 0) return [];
  if (table.name === "traces") return conditions;
  return [
    `"trace_id" in (select "trace_id" from ${quote(RQL_SCHEMA)}.${quote("traces")} where ${conditions.join(" and ")})`,
  ];
}

/** The totals of the view's trace rows in the window, one row per key. */
function totalsQuery(table: RqlTable, windowSql: string): string {
  const columns = table.columns.map((column) => `${column.total} as ${quote(column.name)}`);
  return `select ${columns.join(", ")} from ${view(table)} where ${windowSql} group by ${quote(table.key ?? "")}`;
}

function printExpr(expr: CheckedExpr, params: Params): string {
  const print = (inner: CheckedExpr) => printExpr(inner, params);
  switch (expr.kind) {
    case "column":
      return quote(expr.name);
    case "param":
      return params.add(expr.value, expr.paramType);
    case "output":
      return outputName(expr.index);
    case "count_star":
      return "count(*)";
    case "aggregate":
      return `${expr.fn}(${expr.distinct ? "distinct " : ""}${print(expr.arg)})`;
    case "percentile": {
      const fraction =
        typeof expr.fraction === "number" ? String(expr.fraction) : print(expr.fraction);
      return `percentile_cont(${fraction}) within group (order by ${print(expr.arg)})`;
    }
    case "time_bucket":
      return `date_bin(${print(expr.interval)}, ${print(expr.arg)}, ${BUCKET_ORIGIN})`;
    case "contains":
      return `(${print(expr.list)} @> array[${print(expr.value)}])`;
    case "attribute":
      return `(${print(expr.target)} ->> ${print(expr.key)})`;
    case "binary": {
      const left = expr.op === "/" ? `${print(expr.left)}::double precision` : print(expr.left);
      return `(${left} ${BINARY_SQL[expr.op]} ${print(expr.right)})`;
    }
    case "unary": {
      const postfix = POSTFIX_SQL[expr.op];
      if (postfix) return `(${print(expr.operand)} ${postfix})`;
      return `(${expr.op === "NOT" ? "not" : "-"} ${print(expr.operand)})`;
    }
    case "between":
      return `(${print(expr.value)} ${expr.negated ? "not " : ""}between ${print(expr.low)} and ${print(expr.high)})`;
    case "in":
      return `(${print(expr.value)} ${expr.negated ? "not " : ""}in (${expr.items.map(print).join(", ")}))`;
  }
}

function view(table: RqlTable): string {
  return `${quote(RQL_SCHEMA)}.${quote(table.view)}`;
}

function outputName(index: number): string {
  return quote(`c${index + 1}`);
}

/** Quotes a name of the catalog. Only catalog names and `cN` reach this function. */
function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a catalog name: ${name}`);
  return `"${name}"`;
}
