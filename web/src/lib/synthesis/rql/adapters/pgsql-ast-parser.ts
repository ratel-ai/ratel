import {
  type Expr,
  type From,
  type NodeLocation,
  parse,
  type SelectFromStatement,
  type Statement,
} from "pgsql-ast-parser";
import {
  BINARY_OPS,
  type BinaryOp,
  type ForeignConstruct,
  type ForeignNode,
  type ParsedExpr,
  type ParsedFrom,
  type ParsedSelect,
  type ParsedStatement,
  type ParseResult,
  type Span,
  UNARY_OPS,
  type UnaryOp,
} from "../domain/ast";
import type { RqlParser } from "../ports/parser";

/**
 * The `RqlParser` over `pgsql-ast-parser`. The library parses Postgres; this file maps its tree
 * to the parsed tree of RQL and keeps every refused construct as a `foreign` node.
 */

const JSON_OPERATORS = new Set(["->", "->>", "#>", "#>>", "?", "?|", "?&", "#-", "@>", "<@"]);

export const pgsqlAstParser: RqlParser = {
  parse(text: string): ParseResult {
    let statements: Statement[];
    try {
      statements = parse(text, { locationTracking: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: firstLine(message) };
    }
    return { ok: true, statements: statements.map(mapStatement) };
  },
};

function mapStatement(statement: Statement): ParsedStatement {
  const at = span(statement._location);
  switch (statement.type) {
    case "select":
      return mapSelect(statement, at);
    case "union":
    case "union all":
      return { kind: "set_operation", op: statement.type, at };
    case "with":
    case "with recursive":
      return { kind: "with", at };
    case "values":
      return { kind: "values", at };
    default:
      return { kind: "other", statementType: statement.type, at };
  }
}

function mapSelect(select: SelectFromStatement, at: Span | undefined): ParsedSelect {
  const foreign: ForeignNode[] = [];
  if (Array.isArray(select.distinct)) {
    foreign.push(foreignNode("distinct_on", "DISTINCT ON", select._location));
  }
  if (select.for) foreign.push(foreignNode("locking", `FOR ${select.for.type}`, select._location));
  if (select.skip) foreign.push(foreignNode("locking", select.skip.type, select._location));
  for (const from of select.from ?? []) {
    if (from.type === "table" && from.name.columnNames?.length) {
      foreign.push(foreignNode("column_aliases", "column aliases", from._location));
    }
  }
  return {
    kind: "select",
    distinct: select.distinct === "distinct",
    columns: (select.columns ?? []).map((column) => ({
      expr: mapExpr(column.expr),
      ...(column.alias ? { alias: column.alias.name } : {}),
      at: span(column._location),
    })),
    from: (select.from ?? []).map(mapFrom),
    ...(select.where ? { where: mapExpr(select.where) } : {}),
    groupBy: (select.groupBy ?? []).map(mapExpr),
    ...(select.having ? { having: mapExpr(select.having) } : {}),
    orderBy: (select.orderBy ?? []).map((order) => ({
      expr: mapExpr(order.by),
      ...(order.order ? { direction: order.order === "DESC" ? "desc" : "asc" } : {}),
      ...(order.nulls ? { nulls: order.nulls === "FIRST" ? "first" : "last" } : {}),
      at: span(order._location),
    })),
    ...(select.limit?.limit ? { limit: mapExpr(select.limit.limit) } : {}),
    ...(select.limit?.offset ? { offset: mapExpr(select.limit.offset) } : {}),
    foreign,
    at,
  };
}

function mapFrom(from: From): ParsedFrom {
  const at = span(from._location);
  const joined = from.join != null;
  switch (from.type) {
    case "table":
      return {
        kind: "table",
        name: from.name.name,
        ...(from.name.schema ? { schema: from.name.schema } : {}),
        ...(from.name.alias ? { alias: from.name.alias } : {}),
        joined,
        at,
      };
    case "statement":
      return { kind: "subquery", joined, at };
    case "call":
      return { kind: "function", name: from.function.name, joined, at };
  }
}

function mapExpr(expr: Expr): ParsedExpr {
  const at = span(expr._location);
  switch (expr.type) {
    case "ref":
      if (expr.name === "*") return { kind: "star", ...qualifier(expr.table), at };
      return { kind: "column", name: expr.name, ...qualifier(expr.table), at };
    case "string":
      return { kind: "string", value: expr.value, at };
    case "integer":
      return { kind: "integer", value: expr.value, at };
    case "numeric":
      return { kind: "number", value: expr.value, at };
    case "boolean":
      return { kind: "boolean", value: expr.value, at };
    case "null":
      return { kind: "null", at };
    case "arrayIndex":
      return { kind: "index", target: mapExpr(expr.array), key: mapExpr(expr.index), at };
    case "ternary":
      return {
        kind: "between",
        negated: expr.op === "NOT BETWEEN",
        value: mapExpr(expr.value),
        low: mapExpr(expr.lo),
        high: mapExpr(expr.hi),
        at,
      };
    case "binary":
      return mapBinary(expr, at);
    case "unary":
      if (expr.opSchema || !isUnaryOp(expr.op)) return foreign("operator", expr.op, at);
      return { kind: "unary", op: expr.op, operand: mapExpr(expr.operand), at };
    case "call":
      return mapCall(expr, at);
    case "cast":
      return foreign("cast", "::", at);
    case "constant":
      return foreign("cast", "typed literal", at);
    case "member":
      return foreign("json_operator", expr.op, at);
    case "parameter":
      return foreign("parameter", expr.name, at);
    case "keyword":
      return foreign("keyword", expr.keyword, at);
    case "extract":
      return foreign("extract", "extract", at);
    case "case":
      return foreign("case", "CASE", at);
    case "list":
      return foreign("row", "row", at);
    case "array":
      return foreign("array", "ARRAY", at);
    case "select":
    case "union":
    case "union all":
    case "with":
    case "with recursive":
    case "values":
    case "array select":
      return foreign("subquery", "subquery", at);
    default:
      return foreign("expression", expr.type, at);
  }
}

function mapBinary(expr: Extract<Expr, { type: "binary" }>, at: Span | undefined): ParsedExpr {
  if (expr.op === "IN" || expr.op === "NOT IN") {
    // `in ('a')` parses as one value, not as a list of one.
    const items = expr.right.type === "list" ? expr.right.expressions : [expr.right];
    return {
      kind: "in",
      negated: expr.op === "NOT IN",
      value: mapExpr(expr.left),
      items: items.map(mapExpr),
      at,
    };
  }
  if (expr.opSchema || !isBinaryOp(expr.op)) {
    const construct = JSON_OPERATORS.has(expr.op) ? "json_operator" : "operator";
    return foreign(construct, expr.op, at);
  }
  return { kind: "binary", op: expr.op, left: mapExpr(expr.left), right: mapExpr(expr.right), at };
}

function mapCall(expr: Extract<Expr, { type: "call" }>, at: Span | undefined): ParsedExpr {
  const name = expr.function.name;
  if (expr.function.schema)
    return foreign("schema_function", `${expr.function.schema}.${name}`, at);
  if (expr.over) return foreign("window_function", name, at);
  if (expr.filter) return foreign("aggregate_filter", name, at);
  if (expr.withinGroup) return foreign("within_group", name, at);
  if (expr.orderBy?.length) return foreign("aggregate_order", name, at);
  return {
    kind: "call",
    name,
    args: expr.args.map(mapExpr),
    distinct: expr.distinct === "distinct",
    at,
  };
}

function qualifier(table: { name: string; schema?: string } | undefined): { table?: string } {
  if (!table) return {};
  return { table: table.schema ? `${table.schema}.${table.name}` : table.name };
}

function foreign(construct: ForeignConstruct, detail: string, at: Span | undefined): ForeignNode {
  return { kind: "foreign", construct, detail, ...(at ? { at } : {}) };
}

function foreignNode(
  construct: ForeignConstruct,
  detail: string,
  location: NodeLocation | undefined,
): ForeignNode {
  return foreign(construct, detail, span(location));
}

function isBinaryOp(op: string): op is BinaryOp {
  return (BINARY_OPS as readonly string[]).includes(op);
}

function isUnaryOp(op: string): op is UnaryOp {
  return (UNARY_OPS as readonly string[]).includes(op);
}

function span(location: NodeLocation | undefined): Span | undefined {
  return location ? { start: location.start, end: location.end } : undefined;
}

function firstLine(message: string): string {
  return message.split("\n")[0].trim();
}
