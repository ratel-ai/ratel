import type {
  BinaryOp,
  ForeignNode,
  ParsedExpr,
  ParsedFrom,
  ParsedSelect,
  ParseResult,
  Span,
  UnaryOp,
} from "./ast";
import { RQL_FUNCTIONS, RQL_TABLES, type RqlTable, type RqlType, rqlTable } from "./catalog";
import { fail, nearestName, RqlCompileError } from "./errors";
import { RQL_LIMITS } from "./limits";
import { propertyRefusal, type RqlPropertyCheck } from "./properties";

/**
 * The check: the parsed tree of one query to a typed tree that holds only catalog names and
 * literal values, or an error. `rewrite.ts` prints SQL from this tree alone.
 */

export type ValueType = RqlType | "interval";
export type ParamValue = string | number | boolean;
export type ParamType =
  | "text"
  | "bigint"
  | "double precision"
  | "boolean"
  | "timestamptz"
  | "interval";
export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export type CheckedNode =
  | { kind: "column"; name: string }
  | { kind: "param"; value: ParamValue; paramType: ParamType }
  | { kind: "output"; index: number }
  | { kind: "count_star" }
  | { kind: "aggregate"; fn: AggregateFn; distinct: boolean; arg: CheckedExpr }
  | { kind: "percentile"; fraction: number | CheckedExpr; arg: CheckedExpr }
  | { kind: "time_bucket"; interval: CheckedExpr; arg: CheckedExpr }
  | { kind: "contains"; list: CheckedExpr; value: CheckedExpr }
  | { kind: "rate"; arg: CheckedExpr }
  | { kind: "coalesce"; args: CheckedExpr[] }
  /** One value of a list column per row: `rewrite.ts` reads the list once per value. */
  | { kind: "each"; column: string }
  | { kind: "attribute"; target: CheckedExpr; key: CheckedExpr }
  /** One indexed trace property: `key` is a text parameter. */
  | { kind: "property"; key: CheckedExpr }
  | { kind: "binary"; op: BinaryOp; left: CheckedExpr; right: CheckedExpr }
  | { kind: "unary"; op: UnaryOp; operand: CheckedExpr }
  | {
      kind: "between";
      negated: boolean;
      value: CheckedExpr;
      low: CheckedExpr;
      high: CheckedExpr;
    }
  | { kind: "in"; negated: boolean; value: CheckedExpr; items: CheckedExpr[] };

/** A checked expression: its node, its type, and whether it holds an aggregate. */
export type CheckedExpr = CheckedNode & {
  type: ValueType;
  aggregate: boolean;
  /** A text literal that a comparison can still read as a timestamp. */
  textLiteral?: boolean;
};

export interface CheckedItem {
  expr: CheckedExpr;
  name: string;
  type: RqlType;
}

export interface CheckedSelect {
  table: RqlTable;
  distinct: boolean;
  items: CheckedItem[];
  where?: CheckedExpr;
  groupBy: CheckedExpr[];
  having?: CheckedExpr;
  orderBy: { expr: CheckedExpr; direction?: "asc" | "desc"; nulls?: "first" | "last" }[];
  limit?: number;
}

type Clause = "select" | "where" | "group by" | "having" | "order by";

interface Scope {
  table: RqlTable;
  alias?: string;
  clause: Clause;
  items: readonly CheckedItem[];
  aliases: ReadonlyMap<string, number>;
  insideAggregate: boolean;
  properties: RqlPropertyCheck;
}

const GRAMMAR =
  "select <columns> from <table> [where ...] [group by ...] [having ...] [order by ...] [limit n]";
const NUMERIC: readonly ValueType[] = ["integer", "number"];
const ORDERED: readonly ValueType[] = ["integer", "number", "timestamp", "text"];
const PERCENTILES: Readonly<Record<string, number>> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 };
const INTERVAL = /^\s*(\d{1,4})\s*(minute|minutes|hour|hours|day|days|week|weeks)\s*$/i;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** The Postgres functions an agent reaches for, and the RQL that does the same. */
const POSTGRES_FUNCTIONS: Readonly<Record<string, string>> = {
  date_trunc: "Use time_bucket('1 hour', started_at).",
  date_bin: "Use time_bucket('1 hour', started_at).",
  to_char: "Use time_bucket('1 day', started_at).",
  percentile_cont: "Use percentile(x, 0.95) or p95(x).",
  percentile_disc: "Use percentile(x, 0.95) or p95(x).",
  now: "The window bounds the time. Filter inside it with a literal like '2026-11-01T00:00:00Z'.",
  any: "Use contains(models, 'value').",
  unnest: "Use each(models) to read a row once per value of a list.",
  array_join: "Use each(models) to read a row once per value of a list.",
  arrayjoin: "Use each(models) to read a row once per value of a list.",
  count_if: "Use rate(condition) for a share, or count(*) with the condition in WHERE.",
  countif: "Use rate(condition) for a share, or count(*) with the condition in WHERE.",
  ifnull: "Use coalesce(x, y).",
  nvl: "Use coalesce(x, y).",
  array_position: "Use contains(models, 'value').",
  cardinality: "Use contains(models, 'value').",
};

/**
 * Checks the one statement of the parse, or stops with the error that refuses it. `properties`
 * are the project's: a query reads an indexed one only.
 */
export function checkQuery(
  parsed: ParseResult,
  properties: RqlPropertyCheck = { indexed: [] },
): CheckedSelect {
  if (!parsed.ok) {
    fail(
      "syntax_error",
      `The query does not parse: ${parsed.message}`,
      `Write one SELECT statement: ${GRAMMAR}.`,
      parsed.at,
    );
  }
  if (parsed.statements.length === 0) {
    fail("empty_query", "The query is empty.", `Write one SELECT statement: ${GRAMMAR}.`);
  }
  if (parsed.statements.length > 1) {
    fail(
      "multiple_statements",
      `The query has ${parsed.statements.length} statements.`,
      "Send one SELECT statement. Run a second query for a second question.",
      parsed.statements[1].at,
    );
  }
  const [statement] = parsed.statements;
  switch (statement.kind) {
    case "select":
      return checkSelect(statement, properties);
    case "set_operation":
      return fail(
        "set_operation",
        `RQL has no ${statement.op.toUpperCase()}.`,
        "Run one query for each part, or use one query with OR in WHERE.",
        statement.at,
      );
    case "with":
      return fail(
        "cte",
        "RQL has no WITH.",
        "Write one SELECT from one table. Group and filter in that SELECT.",
        statement.at,
      );
    case "values":
      return fail(
        "not_a_select",
        "RQL has no VALUES.",
        "Write a SELECT from a table.",
        statement.at,
      );
    case "other":
      return fail(
        "not_a_select",
        `RQL reads only: ${statement.statementType.toUpperCase()} is not a SELECT.`,
        "Write a SELECT. RQL cannot change data.",
        statement.at,
      );
  }
}

function checkSelect(select: ParsedSelect, properties: RqlPropertyCheck): CheckedSelect {
  if (select.foreign.length > 0) refuseForeign(select.foreign[0]);
  const { table, alias } = checkFrom(select.from, select.at);
  if (select.offset) {
    fail(
      "unsupported_clause",
      "RQL has no OFFSET.",
      "Narrow the rows with WHERE, or order them with ORDER BY and use LIMIT.",
      at(select.offset),
    );
  }
  const aliases = aliasMap(select, table);
  const scope = (clause: Clause, items: readonly CheckedItem[]): Scope => ({
    table,
    ...(alias ? { alias } : {}),
    clause,
    items,
    aliases: clause === "select" ? new Map() : aliases,
    insideAggregate: false,
    properties,
  });

  const items = checkItems(select, scope("select", []));
  const where = select.where
    ? checkCondition(select.where, scope("where", items), "WHERE")
    : undefined;
  const groupBy = select.groupBy.map((expr) => checkGroupKey(expr, scope("group by", items)));
  const having = select.having
    ? checkCondition(select.having, scope("having", items), "HAVING")
    : undefined;
  const orderBy = select.orderBy.map((order) => ({
    expr: checkOrderKey(order.expr, scope("order by", items)),
    ...(order.direction ? { direction: order.direction } : {}),
    ...(order.nulls ? { nulls: order.nulls } : {}),
  }));
  const checked: CheckedSelect = {
    table,
    distinct: select.distinct,
    items,
    ...(where ? { where } : {}),
    groupBy,
    ...(having ? { having } : {}),
    orderBy,
    ...(select.limit ? { limit: checkLimit(select.limit) } : {}),
  };
  checkGrouping(checked, select);
  return checked;
}

function checkFrom(
  from: readonly ParsedFrom[],
  selectAt: Span | undefined,
): { table: RqlTable; alias?: string } {
  if (from.length === 0) {
    fail("missing_from", "The query has no FROM.", `Read one table: ${tableNames()}.`, selectAt);
  }
  const joined = from.find((source) => source.joined);
  if (joined) {
    fail(
      "join",
      "RQL has no JOIN.",
      "Query one table. Each table copies the columns of the trace that you need: for example traces.models, scores.session_id or events.session_id.",
      joined.at,
    );
  }
  if (from.length > 1) {
    fail(
      "multiple_tables",
      "The query reads more than one table.",
      "Query one table. Each table copies the columns of the trace that you need.",
      from[1].at,
    );
  }
  const [source] = from;
  if (source.kind === "subquery") {
    fail("subquery", "RQL has no subqueries.", "Read one table directly.", source.at);
  }
  if (source.kind === "function") {
    fail(
      "table_function",
      `RQL cannot read from the function ${source.name}.`,
      `Read one table: ${tableNames()}.`,
      source.at,
    );
  }
  if (source.schema) {
    fail(
      "unknown_table",
      `The table ${source.schema}.${source.name} is not an RQL table.`,
      `Write the table name alone: ${tableNames()}.`,
      source.at,
    );
  }
  const table = rqlTable(source.name);
  if (!table) {
    const near = nearestName(source.name, RQL_TABLES);
    fail(
      "unknown_table",
      `The table ${source.name} is not an RQL table.`,
      `${near ? `Did you mean ${near}? ` : ""}The tables are ${tableNames()}.`,
      source.at,
    );
  }
  return { table, ...(source.alias ? { alias: source.alias } : {}) };
}

function checkItems(select: ParsedSelect, scope: Scope): CheckedItem[] {
  if (select.columns.length === 0) {
    fail("syntax_error", "The query selects no columns.", `Write ${GRAMMAR}.`, select.at);
  }
  const items: CheckedItem[] = [];
  for (const [position, column] of select.columns.entries()) {
    if (column.expr.kind === "star") {
      checkQualifier(column.expr.table, scope, column.expr.at);
      // The map of properties is read one key at a time, never whole.
      for (const catalogColumn of scope.table.columns.filter(({ type }) => type !== "properties")) {
        items.push({
          expr: {
            kind: "column",
            name: catalogColumn.name,
            type: catalogColumn.type,
            aggregate: false,
          },
          name: catalogColumn.name,
          type: catalogColumn.type,
        });
      }
      continue;
    }
    if (column.alias && column.alias.length > RQL_LIMITS.maxAliasChars) {
      fail(
        "syntax_error",
        `An output name has ${column.alias.length} characters. RQL reads at most ${RQL_LIMITS.maxAliasChars}.`,
        `Give the column a shorter name after AS, of ${RQL_LIMITS.maxAliasChars} characters or less.`,
        column.at,
      );
    }
    const expr = checkExpr(column.expr, scope);
    items.push({
      expr,
      name: column.alias ?? defaultName(column.expr, position),
      type: expr.type as RqlType,
    });
  }
  if (items.length > RQL_LIMITS.maxSelectItems) {
    fail(
      "too_many_columns",
      `The query selects ${items.length} columns. RQL gives at most ${RQL_LIMITS.maxSelectItems}${select.columns.some(({ expr }) => expr.kind === "star") ? " (each column of * counts)" : ""}.`,
      `Select at most ${RQL_LIMITS.maxSelectItems} columns: name the columns you need.`,
      select.at,
    );
  }
  return uniqueNames(items);
}

function checkCondition(parsed: ParsedExpr, scope: Scope, clause: string): CheckedExpr {
  const expr = checkExpr(parsed, scope);
  if (expr.type !== "boolean") {
    fail(
      "type_mismatch",
      `${clause} needs a true or false condition, not a value of type ${expr.type}.`,
      "Compare the value, for example: duration_ms > 1000.",
      at(parsed),
    );
  }
  return expr;
}

function checkGroupKey(parsed: ParsedExpr, scope: Scope): CheckedExpr {
  const output = outputReference(parsed, scope, "column first");
  if (output) {
    if (output.aggregate) {
      fail(
        "aggregate_misuse",
        "GROUP BY names an aggregate.",
        "Group by plain columns or time_bucket(...), not by count, sum or another aggregate.",
        at(parsed),
      );
    }
    return output;
  }
  return checkExpr(parsed, scope);
}

function checkOrderKey(parsed: ParsedExpr, scope: Scope): CheckedExpr {
  return outputReference(parsed, scope, "alias first") ?? checkExpr(parsed, scope);
}

/**
 * A reference to a select item: a position (`order by 2`) or an alias. GROUP BY reads a name as
 * a column of the table first, ORDER BY as an alias first, as Postgres does.
 */
function outputReference(
  parsed: ParsedExpr,
  scope: Scope,
  order: "column first" | "alias first",
): CheckedExpr | undefined {
  if (parsed.kind === "integer") {
    const index = parsed.value - 1;
    const item = scope.items[index];
    if (!item) {
      fail(
        "unknown_column",
        `${scope.clause.toUpperCase()} names position ${parsed.value}, but the select has ${scope.items.length} columns.`,
        `Give a position from 1 to ${scope.items.length}, or a column name.`,
        parsed.at,
      );
    }
    return { kind: "output", index, type: item.type, aggregate: item.expr.aggregate };
  }
  if (parsed.kind !== "column" || parsed.table) return undefined;
  const index = scope.aliases.get(parsed.name);
  if (index === undefined) return undefined;
  if (order === "column first" && findColumn(scope.table, parsed.name)) return undefined;
  const item = scope.items[index];
  return { kind: "output", index, type: item.type, aggregate: item.expr.aggregate };
}

function checkExpr(parsed: ParsedExpr, scope: Scope): CheckedExpr {
  switch (parsed.kind) {
    case "column":
      return checkColumn(parsed, scope);
    case "star":
      return fail(
        "wrong_arguments",
        "* works only as select * and as count(*).",
        "Name the columns.",
        parsed.at,
      );
    case "string":
      if (parsed.value.includes("\u0000")) {
        fail(
          "invalid_literal",
          "A text literal has a NUL character, which Postgres text cannot hold.",
          "Remove the NUL character from the literal.",
          parsed.at,
        );
      }
      return {
        kind: "param",
        value: parsed.value,
        paramType: "text",
        type: "text",
        aggregate: false,
        textLiteral: true,
      };
    case "integer":
      if (!Number.isSafeInteger(parsed.value)) {
        fail(
          "invalid_literal",
          "The integer is too large.",
          `Give an integer from ${Number.MIN_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}.`,
          parsed.at,
        );
      }
      return {
        kind: "param",
        value: parsed.value,
        paramType: "bigint",
        type: "integer",
        aggregate: false,
      };
    case "number":
      if (!Number.isFinite(parsed.value)) {
        fail("invalid_literal", "The number is not finite.", "Give a smaller number.", parsed.at);
      }
      return {
        kind: "param",
        value: parsed.value,
        paramType: "double precision",
        type: "number",
        aggregate: false,
      };
    case "boolean":
      return {
        kind: "param",
        value: parsed.value,
        paramType: "boolean",
        type: "boolean",
        aggregate: false,
      };
    case "null":
      return fail(
        "invalid_literal",
        "RQL has no NULL literal.",
        "Use IS NULL or IS NOT NULL to test for a missing value.",
        parsed.at,
      );
    case "binary":
      return checkBinary(parsed, scope);
    case "unary":
      return checkUnary(parsed, scope);
    case "between": {
      const value = checkExpr(parsed.value, scope);
      const low = checkExpr(parsed.low, scope);
      const high = checkExpr(parsed.high, scope);
      const [v1, lo] = comparable(value, low, "BETWEEN", parsed.at);
      const [, hi] = comparable(v1, high, "BETWEEN", parsed.at);
      return {
        kind: "between",
        negated: parsed.negated,
        value: v1,
        low: lo,
        high: hi,
        type: "boolean",
        aggregate: v1.aggregate || lo.aggregate || hi.aggregate,
      };
    }
    case "in": {
      let value = checkExpr(parsed.value, scope);
      const items = parsed.items.map((item) => {
        const [v, checked] = comparable(value, checkExpr(item, scope), "IN", parsed.at);
        value = v;
        return checked;
      });
      return {
        kind: "in",
        negated: parsed.negated,
        value,
        items,
        type: "boolean",
        aggregate: value.aggregate || items.some((item) => item.aggregate),
      };
    }
    case "index":
      return checkAttribute(parsed, scope);
    case "call":
      return checkCall(parsed, scope);
    case "foreign":
      return refuseForeign(parsed);
  }
}

function checkColumn(parsed: Extract<ParsedExpr, { kind: "column" }>, scope: Scope): CheckedExpr {
  if (parsed.table === "properties" && findColumn(scope.table, "properties")) {
    fail(
      "wrong_arguments",
      `properties.${parsed.name} names a property as a column.`,
      `Write the name in single quotes: properties['${parsed.name}'].`,
      parsed.at,
    );
  }
  checkQualifier(parsed.table, scope, parsed.at);
  const column = findColumn(scope.table, parsed.name);
  if (column?.type === "properties") {
    fail(
      "wrong_arguments",
      "properties is read one property at a time.",
      "Read one property with properties['name'], for example properties['organization'] = 'acme'.",
      parsed.at,
    );
  }
  if (column) return { kind: "column", name: column.name, type: column.type, aggregate: false };
  const index = parsed.table ? undefined : scope.aliases.get(parsed.name);
  if (index !== undefined && scope.clause === "having") return scope.items[index].expr;
  if (index !== undefined && scope.clause === "where") {
    fail(
      "unknown_column",
      `WHERE names ${parsed.name}, which is an alias of the select.`,
      "WHERE runs before the select: repeat the expression, not its alias. Or filter the alias in HAVING.",
      parsed.at,
    );
  }
  const near = nearestName(parsed.name, scope.table.columns);
  fail(
    "unknown_column",
    `The table ${scope.table.name} has no column ${parsed.name}.`,
    parsed.name === "properties"
      ? `The table ${scope.table.name} has no trace properties. Read them on the traces table, and group by session_id or user_id there.`
      : `${near ? `Did you mean ${near}? ` : ""}The columns of ${scope.table.name} are ${scope.table.columns.map((c) => c.name).join(", ")}.`,
    parsed.at,
  );
}

function checkQualifier(
  qualifier: string | undefined,
  scope: Scope,
  place: Span | undefined,
): void {
  if (!qualifier || qualifier === scope.table.name || qualifier === scope.alias) return;
  fail(
    "unknown_table",
    `The query reads no table or alias ${qualifier}.`,
    `Write the column alone, or qualify it with ${scope.alias ?? scope.table.name}.`,
    place,
  );
}

function checkBinary(parsed: Extract<ParsedExpr, { kind: "binary" }>, scope: Scope): CheckedExpr {
  const left = checkExpr(parsed.left, scope);
  const right = checkExpr(parsed.right, scope);
  const aggregate = left.aggregate || right.aggregate;
  const node = (l: CheckedExpr, r: CheckedExpr, type: ValueType): CheckedExpr => ({
    kind: "binary",
    op: parsed.op,
    left: l,
    right: r,
    type,
    aggregate,
  });
  switch (parsed.op) {
    case "AND":
    case "OR":
      expectType(left, ["boolean"], parsed.op, parsed.left);
      expectType(right, ["boolean"], parsed.op, parsed.right);
      return node(left, right, "boolean");
    case "+":
    case "-":
    case "*":
    case "/": {
      expectType(left, NUMERIC, parsed.op, parsed.left);
      expectType(right, NUMERIC, parsed.op, parsed.right);
      const integer = left.type === "integer" && right.type === "integer" && parsed.op !== "/";
      return node(left, right, integer ? "integer" : "number");
    }
    case "LIKE":
    case "NOT LIKE":
    case "ILIKE":
    case "NOT ILIKE":
      expectType(left, ["text"], parsed.op, parsed.left);
      expectType(right, ["text"], parsed.op, parsed.right);
      return node(left, right, "boolean");
    case "=":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const [l, r] = comparable(left, right, parsed.op, parsed.at);
      if (l.type === "boolean" && parsed.op !== "=" && parsed.op !== "!=") {
        fail(
          "type_mismatch",
          `${parsed.op} does not order true and false.`,
          "Use = or !=.",
          parsed.at,
        );
      }
      return node(l, r, "boolean");
    }
  }
}

function checkUnary(parsed: Extract<ParsedExpr, { kind: "unary" }>, scope: Scope): CheckedExpr {
  const operand = checkExpr(parsed.operand, scope);
  const node = (type: ValueType): CheckedExpr => ({
    kind: "unary",
    op: parsed.op,
    operand,
    type,
    aggregate: operand.aggregate,
  });
  switch (parsed.op) {
    case "-":
      expectType(operand, NUMERIC, "-", parsed.operand);
      return node(operand.type);
    case "IS NULL":
    case "IS NOT NULL":
      return node("boolean");
    default:
      expectType(operand, ["boolean"], parsed.op, parsed.operand);
      return node("boolean");
  }
}

function checkAttribute(parsed: Extract<ParsedExpr, { kind: "index" }>, scope: Scope): CheckedExpr {
  if (isPropertiesColumn(parsed.target, scope)) return checkProperty(parsed, scope);
  const target = checkExpr(parsed.target, scope);
  if (target.type !== "attributes") {
    fail(
      "wrong_arguments",
      `[...] reads a key of attributes, and ${describe(parsed.target)} is of type ${target.type}.`,
      target.type === "text_list"
        ? "Use contains(list, 'value') to test a list."
        : "Use attributes['key'] on the events table.",
      parsed.at,
    );
  }
  if (parsed.key.kind !== "string" || parsed.key.value === "") {
    fail(
      "wrong_arguments",
      "An attribute key must be a text literal.",
      "Write the key in single quotes, for example attributes['gen_ai.tool.name'].",
      at(parsed.key),
    );
  }
  const key = checkExpr(parsed.key, scope);
  return { kind: "attribute", target, key, type: "text", aggregate: target.aggregate };
}

/** Whether an expression is the `properties` column of the table, as `properties[...]` reads it. */
function isPropertiesColumn(parsed: ParsedExpr, scope: Scope): boolean {
  return (
    parsed.kind === "column" &&
    parsed.name === "properties" &&
    (!parsed.table || parsed.table === scope.table.name || parsed.table === scope.alias) &&
    findColumn(scope.table, "properties")?.type === "properties"
  );
}

/**
 * `properties['name']`: one trace property, by a text literal that is a bound value, never a name
 * of the SQL. Only a name the project indexes; a column property names its column.
 */
function checkProperty(parsed: Extract<ParsedExpr, { kind: "index" }>, scope: Scope): CheckedExpr {
  if (parsed.key.kind !== "string" || parsed.key.value === "") {
    fail(
      "wrong_arguments",
      "A property name must be a text literal.",
      "Write the name in single quotes, for example properties['organization'].",
      at(parsed.key),
    );
  }
  const refusal = propertyRefusal(parsed.key.value, scope.table, scope.properties);
  if (refusal) {
    const place = at(parsed.key);
    throw new RqlCompileError({ ...refusal, ...(place ? { at: place } : {}) });
  }
  return { kind: "property", key: checkExpr(parsed.key, scope), type: "text", aggregate: false };
}

/** The functions that are a subscript, not a call. */
const SUBSCRIPTS: readonly string[] = ["attributes", "properties"];

function checkCall(parsed: Extract<ParsedExpr, { kind: "call" }>, scope: Scope): CheckedExpr {
  const name = parsed.name.toLowerCase();
  const fn = RQL_FUNCTIONS.find(
    (candidate) => candidate.name === name && !SUBSCRIPTS.includes(name),
  );
  if (!fn) {
    const hint =
      (Object.hasOwn(POSTGRES_FUNCTIONS, name) ? POSTGRES_FUNCTIONS[name] : undefined) ??
      postgresFamilyHint(name);
    const near = nearestName(name, RQL_FUNCTIONS);
    fail(
      "unknown_function",
      `${parsed.name} is not an RQL function.`,
      hint ??
        `${near ? `Did you mean ${near}? ` : ""}The functions are ${RQL_FUNCTIONS.map((f) => f.name).join(", ")}.`,
      parsed.at,
    );
  }
  if (parsed.distinct && name !== "count") {
    fail(
      "wrong_arguments",
      `DISTINCT works only in count, not in ${name}.`,
      "Write count(distinct x) or count_distinct(x).",
      parsed.at,
    );
  }
  if (fn.aggregate) {
    if (scope.insideAggregate) {
      fail(
        "aggregate_misuse",
        `${name} is inside another aggregate.`,
        "Aggregate a column, not an aggregate. Run a second query for a total of totals.",
        parsed.at,
      );
    }
    if (scope.clause === "where" || scope.clause === "group by") {
      fail(
        "aggregate_misuse",
        `${scope.clause.toUpperCase()} cannot hold ${name}.`,
        scope.clause === "where"
          ? "Filter an aggregate in HAVING."
          : "Group by plain columns or time_bucket(...).",
        parsed.at,
      );
    }
  }
  const inner: Scope = fn.aggregate ? { ...scope, insideAggregate: true } : scope;
  const args = (count: number): ParsedExpr[] => {
    if (parsed.args.length !== count) {
      fail(
        "wrong_arguments",
        `${name} takes ${count} argument${count === 1 ? "" : "s"}, and the query gives ${parsed.args.length}.`,
        `Write ${fn.signature}.`,
        parsed.at,
      );
    }
    return parsed.args;
  };
  /** The argument of an aggregate. An alias in HAVING stands for its expression, so an aggregate can reach here inside another. */
  const plain = (arg: CheckedExpr): CheckedExpr => {
    if (arg.aggregate) {
      fail(
        "aggregate_misuse",
        `${name} is applied to an aggregate.`,
        "Aggregate a column, not an aggregate. Run a second query for a total of totals.",
        parsed.at,
      );
    }
    return arg;
  };
  const aggregate = (fnName: AggregateFn, arg: CheckedExpr, distinct: boolean, type: ValueType) =>
    ({
      kind: "aggregate",
      fn: fnName,
      distinct,
      arg: plain(arg),
      type,
      aggregate: true,
    }) as CheckedExpr;

  switch (name) {
    case "count": {
      const [arg] = args(1);
      if (arg.kind === "star") {
        checkQualifier(arg.table, scope, arg.at);
        if (parsed.distinct) {
          fail(
            "wrong_arguments",
            "count(distinct *) has no column.",
            "Write count(distinct x).",
            parsed.at,
          );
        }
        return { kind: "count_star", type: "integer", aggregate: true };
      }
      return aggregate("count", checkExpr(arg, inner), parsed.distinct, "integer");
    }
    case "count_distinct":
      return aggregate("count", checkExpr(args(1)[0], inner), true, "integer");
    case "sum": {
      const [arg] = args(1);
      const checked = expectType(checkExpr(arg, inner), NUMERIC, name, arg);
      return aggregate("sum", checked, false, checked.type);
    }
    case "avg": {
      const [arg] = args(1);
      return aggregate(
        "avg",
        expectType(checkExpr(arg, inner), NUMERIC, name, arg),
        false,
        "number",
      );
    }
    case "min":
    case "max": {
      const [arg] = args(1);
      const checked = expectType(checkExpr(arg, inner), ORDERED, name, arg);
      return aggregate(name, checked, false, checked.type);
    }
    case "percentile": {
      const [arg, fraction] = args(2);
      const checked = expectType(checkExpr(arg, inner), NUMERIC, name, arg);
      if (
        (fraction.kind !== "number" && fraction.kind !== "integer") ||
        fraction.value < 0 ||
        fraction.value > 1
      ) {
        fail(
          "wrong_arguments",
          "The fraction of percentile must be a number from 0 to 1.",
          "Give a fraction from 0 to 1, for example percentile(duration_ms, 0.95).",
          at(fraction),
        );
      }
      const param: CheckedExpr = {
        kind: "param",
        value: fraction.value,
        paramType: "double precision",
        type: "number",
        aggregate: false,
      };
      return { kind: "percentile", fraction: param, arg: checked, type: "number", aggregate: true };
    }
    case "time_bucket": {
      const [interval, arg] = args(2);
      const checked = expectType(checkExpr(arg, inner), ["timestamp"], name, arg);
      return {
        kind: "time_bucket",
        interval: checkInterval(interval),
        arg: checked,
        type: "timestamp",
        aggregate: checked.aggregate,
      };
    }
    case "rate": {
      const [arg] = args(1);
      const checked = plain(expectType(checkExpr(arg, inner), ["boolean"], name, arg));
      return { kind: "rate", arg: checked, type: "number", aggregate: true };
    }
    case "coalesce": {
      if (parsed.args.length < 2 || parsed.args.length > RQL_LIMITS.maxListItems) {
        fail(
          "wrong_arguments",
          `coalesce takes 2 to ${RQL_LIMITS.maxListItems} arguments, and the query gives ${parsed.args.length}.`,
          `Write ${fn.signature}.`,
          parsed.at,
        );
      }
      const checked = parsed.args.map((arg) => checkExpr(arg, inner));
      let [first] = checked;
      const rest = checked.slice(1).map((arg) => {
        const [l, r] = comparable(first, arg, name, parsed.at);
        first = l;
        return r;
      });
      const all = [first, ...rest];
      const type = all.every(({ type }) => type === "integer")
        ? "integer"
        : NUMERIC.includes(first.type)
          ? "number"
          : first.type;
      return {
        kind: "coalesce",
        args: all,
        type,
        aggregate: all.some((arg) => arg.aggregate),
      };
    }
    case "each": {
      const [list] = args(1);
      if (list.kind !== "column") {
        fail(
          "wrong_arguments",
          `each reads a list column, and ${describe(list)} is not a column.`,
          "Write each(models), each(tools), each(agents), each(mcp_servers) or each(tasks).",
          at(list),
        );
      }
      const column = expectType(checkExpr(list, inner), ["text_list"], name, list);
      return {
        kind: "each",
        column: (column as { name: string }).name,
        type: "text",
        aggregate: false,
      };
    }
    case "contains": {
      const [list, value] = args(2);
      const checkedList = expectType(checkExpr(list, inner), ["text_list"], name, list);
      const checkedValue = expectType(checkExpr(value, inner), ["text"], name, value);
      return {
        kind: "contains",
        list: checkedList,
        value: checkedValue,
        type: "boolean",
        aggregate: checkedList.aggregate || checkedValue.aggregate,
      };
    }
    default: {
      const [arg] = args(1);
      const checked = expectType(checkExpr(arg, inner), NUMERIC, name, arg);
      return {
        kind: "percentile",
        fraction: PERCENTILES[name],
        arg: checked,
        type: "number",
        aggregate: true,
      };
    }
  }
}

function checkInterval(parsed: ParsedExpr): CheckedExpr {
  const match = parsed.kind === "string" ? INTERVAL.exec(parsed.value) : null;
  const count = match ? Number(match[1]) : 0;
  if (!match || count < 1) {
    fail(
      "wrong_arguments",
      "The bucket of time_bucket must be a text literal like '5 minutes', '1 hour', '1 day' or '1 week'.",
      "Write time_bucket('1 hour', started_at).",
      at(parsed),
    );
  }
  const unit = match[2].toLowerCase().replace(/s$/, "");
  return {
    kind: "param",
    value: `${count} ${unit}${count === 1 ? "" : "s"}`,
    paramType: "interval",
    type: "interval",
    aggregate: false,
  };
}

function checkLimit(parsed: ParsedExpr): number {
  if (parsed.kind !== "integer" || !Number.isSafeInteger(parsed.value) || parsed.value < 0) {
    fail(
      "invalid_limit",
      "LIMIT must be a whole number of rows, 0 or more.",
      "Write LIMIT 100, for example.",
      at(parsed),
    );
  }
  return parsed.value;
}

/** In a query that groups, each value outside an aggregate must be a key of GROUP BY. */
function checkGrouping(select: CheckedSelect, parsed: ParsedSelect): void {
  const grouping =
    select.groupBy.length > 0 ||
    select.items.some((item) => item.expr.aggregate) ||
    select.having != null ||
    select.orderBy.some((order) => order.expr.aggregate);
  if (!grouping) return;
  const keys = new Set(
    select.groupBy.map((key) =>
      fingerprint(key.kind === "output" ? select.items[key.index].expr : key),
    ),
  );
  // A `*` gives more items than the parsed columns: their places do not match.
  const itemsAt = select.items.length === parsed.columns.length;
  const parts: { expr: CheckedExpr; at?: Span; place: string }[] = [
    ...select.items.map((item, i) => ({
      expr: item.expr,
      at: itemsAt ? parsed.columns[i]?.at : undefined,
      place: "the select",
    })),
    ...(select.having ? [{ expr: select.having, at: at(parsed.having), place: "HAVING" }] : []),
    ...select.orderBy.map((order, i) => ({
      expr: order.expr,
      at: parsed.orderBy[i]?.at,
      place: "ORDER BY",
    })),
  ];
  for (const part of parts) {
    const column = ungroupedColumn(part.expr, keys);
    if (column) {
      fail(
        "ungrouped_column",
        `${part.place} uses ${column} outside an aggregate, and GROUP BY does not name it.`,
        `Add ${column} to GROUP BY, or put it in an aggregate such as count, min or max.`,
        part.at,
      );
    }
  }
}

function ungroupedColumn(expr: CheckedExpr, keys: ReadonlySet<string>): string | undefined {
  if (keys.has(fingerprint(expr))) return undefined;
  switch (expr.kind) {
    case "column":
      return expr.name;
    case "param":
    case "output":
    case "count_star":
    case "aggregate":
    case "percentile":
      return undefined;
    case "time_bucket":
      return ungroupedColumn(expr.arg, keys);
    case "contains":
      return ungroupedColumn(expr.list, keys) ?? ungroupedColumn(expr.value, keys);
    case "rate":
      return undefined;
    case "coalesce":
      return expr.args.map((arg) => ungroupedColumn(arg, keys)).find(Boolean);
    case "each":
      return `each(${expr.column})`;
    case "attribute":
      return ungroupedColumn(expr.target, keys) && "attributes[...]";
    case "property":
      return `properties['${String((expr.key as { value?: unknown }).value)}']`;
    case "binary":
      return ungroupedColumn(expr.left, keys) ?? ungroupedColumn(expr.right, keys);
    case "unary":
      return ungroupedColumn(expr.operand, keys);
    case "between":
      return (
        ungroupedColumn(expr.value, keys) ??
        ungroupedColumn(expr.low, keys) ??
        ungroupedColumn(expr.high, keys)
      );
    case "in":
      return (
        ungroupedColumn(expr.value, keys) ??
        expr.items.map((item) => ungroupedColumn(item, keys)).find(Boolean)
      );
  }
}

/**
 * Makes two operands comparable: the same family of type, with a text literal read as a
 * timestamp when the other side is a timestamp.
 */
function comparable(
  left: CheckedExpr,
  right: CheckedExpr,
  op: string,
  place: Span | undefined,
): [CheckedExpr, CheckedExpr] {
  if (left.type === "timestamp" && right.textLiteral) return [left, asTimestamp(right, place)];
  if (right.type === "timestamp" && left.textLiteral) return [asTimestamp(left, place), right];
  const family = (type: ValueType) => (NUMERIC.includes(type) ? "number" : type);
  const same = family(left.type) === family(right.type);
  if (
    !same ||
    left.type === "attributes" ||
    left.type === "text_list" ||
    left.type === "interval"
  ) {
    fail(
      "type_mismatch",
      `${op} compares a value of type ${left.type} with a value of type ${right.type}.`,
      left.type === "text_list" || right.type === "text_list"
        ? "Use contains(list, 'value') to test a list."
        : left.type === "attributes" || right.type === "attributes"
          ? "Compare one key: attributes['key'] = 'value'."
          : "Compare values of the same type. describe_rql_schema gives the type of each column.",
      place,
    );
  }
  return [left, right];
}

function asTimestamp(literal: CheckedExpr, place: Span | undefined): CheckedExpr {
  const text = literal.kind === "param" ? String(literal.value).trim() : "";
  const match = TIMESTAMP.exec(text);
  const iso =
    text.length === 10 ? `${text}T00:00:00Z` : `${text.replace(" ", "T")}${match?.[1] ? "" : "Z"}`;
  const time = match && isCalendarTime(text) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) {
    fail(
      "invalid_literal",
      `'${text}' is not a timestamp.`,
      "Write an ISO 8601 timestamp, for example '2026-11-01T00:00:00Z' or '2026-11-01'.",
      place,
    );
  }
  return {
    kind: "param",
    value: new Date(time).toISOString(),
    paramType: "timestamptz",
    type: "timestamp",
    aggregate: false,
  };
}

/** Whether each part of the timestamp exists: no 30 February, no hour 24. Date.parse moves them. */
function isCalendarTime(text: string): boolean {
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text) ?? [];
  if (y === undefined) return false;
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    Number(h) < 24 &&
    Number(mi) < 60 &&
    Number(sec) < 60
  );
}

function expectType(
  expr: CheckedExpr,
  types: readonly ValueType[],
  where: string,
  parsed: ParsedExpr,
): CheckedExpr {
  if (types.includes(expr.type)) return expr;
  return fail(
    "type_mismatch",
    `${where} needs a value of type ${types.join(" or ")}, and ${describe(parsed)} is of type ${expr.type}.`,
    `Give ${where} a value of type ${types.join(" or ")}. describe_rql_schema gives the type of each column.`,
    at(parsed),
  );
}

function refuseForeign(node: ForeignNode): never {
  switch (node.construct) {
    case "cast":
      return fail(
        "postgres_syntax",
        "RQL has no casts (:: or a typed literal).",
        "Compare a column with a literal of its type: a timestamp column with '2026-11-01T00:00:00Z', a number with 1000.",
        node.at,
      );
    case "json_operator":
      return fail(
        "postgres_syntax",
        `RQL has no ${node.detail} operator.`,
        node.detail === "@>" || node.detail === "<@"
          ? "Use contains(list, 'value') to test a list."
          : "Read one attribute with attributes['key'].",
        node.at,
      );
    case "operator":
      return fail(
        "postgres_syntax",
        `RQL has no ${node.detail} operator.`,
        node.detail === "&&"
          ? "Use contains(list, 'value') for each value, joined with OR."
          : "Use = != < <= > >= LIKE ILIKE IN BETWEEN IS NULL AND OR NOT + - * /.",
        node.at,
      );
    case "parameter":
      return fail(
        "postgres_syntax",
        `RQL has no parameters (${node.detail}).`,
        "Write the value as a literal. The compiler binds every literal as a parameter.",
        node.at,
      );
    case "keyword":
      return fail(
        "postgres_syntax",
        `RQL has no ${node.detail}.`,
        "The window bounds the time. Filter inside it with a literal like '2026-11-01T00:00:00Z'.",
        node.at,
      );
    case "extract":
      return fail(
        "postgres_syntax",
        "RQL has no EXTRACT.",
        "Use time_bucket('1 hour', started_at) to group by time.",
        node.at,
      );
    case "array":
    case "row":
      return fail(
        "postgres_syntax",
        "RQL has no arrays or rows of values.",
        "Use contains(list, 'value'), or IN ('a', 'b') for a list of values.",
        node.at,
      );
    case "schema_function":
      return fail(
        "postgres_syntax",
        `RQL has no function ${node.detail}.`,
        `Use the RQL functions: ${RQL_FUNCTIONS.map((f) => f.name).join(", ")}.`,
        node.at,
      );
    case "within_group":
      return fail(
        "postgres_syntax",
        `RQL has no WITHIN GROUP (${node.detail}).`,
        "Use percentile(x, 0.95) or p95(x).",
        node.at,
      );
    case "subquery":
      return fail(
        "subquery",
        "RQL has no subqueries.",
        "Write one SELECT from one table.",
        node.at,
      );
    case "case":
      return fail(
        "unsupported_clause",
        "RQL has no CASE.",
        "Filter the rows with WHERE, or group them with GROUP BY.",
        node.at,
      );
    case "window_function":
      return fail(
        "unsupported_clause",
        `RQL has no window functions (${node.detail} OVER).`,
        "Aggregate with GROUP BY.",
        node.at,
      );
    case "aggregate_filter":
      return fail(
        "unsupported_clause",
        `RQL has no FILTER on an aggregate (${node.detail}).`,
        "Filter the rows with WHERE, or run one query for each group.",
        node.at,
      );
    case "aggregate_order":
      return fail(
        "unsupported_clause",
        `RQL has no ORDER BY inside an aggregate (${node.detail}).`,
        "Order the result with ORDER BY at the end of the query.",
        node.at,
      );
    case "distinct_on":
      return fail(
        "unsupported_clause",
        "RQL has no DISTINCT ON.",
        "Use SELECT DISTINCT, or GROUP BY with min or max.",
        node.at,
      );
    case "locking":
      return fail(
        "unsupported_clause",
        `RQL has no ${node.detail}.`,
        "Remove it: RQL only reads.",
        node.at,
      );
    case "column_aliases":
      return fail(
        "unsupported_clause",
        "RQL has no column aliases on a table.",
        "Give aliases in the select: select duration_ms as d.",
        node.at,
      );
    case "expression":
      return fail(
        "postgres_syntax",
        `RQL has no ${node.detail} expression.`,
        "Use the RQL operators and functions. describe_rql_schema lists them.",
        node.at,
      );
  }
}

function postgresFamilyHint(name: string): string | undefined {
  if (name.startsWith("json")) return "Read one attribute with attributes['key'].";
  if (name.startsWith("array_")) return "Use contains(list, 'value').";
  return undefined;
}

function aliasMap(select: ParsedSelect, table: RqlTable): Map<string, number> {
  const aliases = new Map<string, number>();
  let index = 0;
  for (const column of select.columns) {
    if (column.expr.kind === "star") {
      index += table.columns.length;
      continue;
    }
    if (column.alias && !aliases.has(column.alias)) aliases.set(column.alias, index);
    index += 1;
  }
  return aliases;
}

function findColumn(table: RqlTable, name: string) {
  return table.columns.find((column) => column.name === name);
}

function defaultName(parsed: ParsedExpr, position: number): string {
  if (parsed.kind === "column") return parsed.name;
  if (parsed.kind === "call") return parsed.name.toLowerCase();
  if (parsed.kind === "index" && parsed.key.kind === "string") return parsed.key.value;
  return `column_${position + 1}`;
}

/** Gives each output column a name no other column has: a repeated name gets `_2`, `_3`... */
function uniqueNames(items: CheckedItem[]): CheckedItem[] {
  const taken = new Set<string>();
  const given = items.map((item) => item.name);
  return items.map((item, i) => {
    let name = item.name;
    // The first column of a name keeps it, unless an earlier column took it already.
    for (let n = 2; taken.has(name) || (name !== item.name && given.includes(name)); n++) {
      name = `${item.name}_${n}`;
    }
    taken.add(name);
    return name === given[i] ? item : { ...item, name };
  });
}

function describe(parsed: ParsedExpr): string {
  if (parsed.kind === "column") return parsed.name;
  if (parsed.kind === "call") return `${parsed.name}(...)`;
  if (parsed.kind === "string") return "a text literal";
  if (parsed.kind === "integer" || parsed.kind === "number") return "a number";
  if (parsed.kind === "boolean") return "a boolean";
  return "the expression";
}

function tableNames(): string {
  return RQL_TABLES.map((table) => table.name).join(", ");
}

function fingerprint(expr: CheckedExpr): string {
  return JSON.stringify(expr);
}

function at(parsed: ParsedExpr | undefined): Span | undefined {
  return parsed && "at" in parsed ? parsed.at : undefined;
}
