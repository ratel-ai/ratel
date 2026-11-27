/**
 * The parsed tree that the parser port gives the checker. It holds the constructs that RQL can
 * accept, and a `foreign` node for each construct that RQL refuses, so that the checker (not the
 * parser) gives the error. No type of the parser library appears here.
 */

/** Offsets in the query text. */
export interface Span {
  start: number;
  end: number;
}

export const BINARY_OPS = [
  "AND",
  "OR",
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "LIKE",
  "NOT LIKE",
  "ILIKE",
  "NOT ILIKE",
] as const;
export type BinaryOp = (typeof BINARY_OPS)[number];

export const UNARY_OPS = [
  "NOT",
  "-",
  "IS NULL",
  "IS NOT NULL",
  "IS TRUE",
  "IS NOT TRUE",
  "IS FALSE",
  "IS NOT FALSE",
] as const;
export type UnaryOp = (typeof UNARY_OPS)[number];

/** A construct of Postgres or SQL that RQL refuses. `detail` names it (an operator, a keyword). */
export type ForeignConstruct =
  | "cast"
  | "json_operator"
  | "operator"
  | "parameter"
  | "keyword"
  | "extract"
  | "array"
  | "row"
  | "schema_function"
  | "case"
  | "window_function"
  | "aggregate_filter"
  | "aggregate_order"
  | "within_group"
  | "subquery"
  | "expression"
  | "distinct_on"
  | "locking"
  | "column_aliases";

export interface ForeignNode {
  kind: "foreign";
  construct: ForeignConstruct;
  detail: string;
  at?: Span;
}

export type ParsedExpr =
  | { kind: "column"; name: string; table?: string; at?: Span }
  | { kind: "star"; table?: string; at?: Span }
  | { kind: "string"; value: string; at?: Span }
  | { kind: "integer"; value: number; at?: Span }
  | { kind: "number"; value: number; at?: Span }
  | { kind: "boolean"; value: boolean; at?: Span }
  | { kind: "null"; at?: Span }
  | { kind: "call"; name: string; args: ParsedExpr[]; distinct: boolean; at?: Span }
  | { kind: "index"; target: ParsedExpr; key: ParsedExpr; at?: Span }
  | { kind: "binary"; op: BinaryOp; left: ParsedExpr; right: ParsedExpr; at?: Span }
  | { kind: "unary"; op: UnaryOp; operand: ParsedExpr; at?: Span }
  | {
      kind: "between";
      negated: boolean;
      value: ParsedExpr;
      low: ParsedExpr;
      high: ParsedExpr;
      at?: Span;
    }
  | { kind: "in"; negated: boolean; value: ParsedExpr; items: ParsedExpr[]; at?: Span }
  | ForeignNode;

export type ParsedFrom =
  | { kind: "table"; name: string; schema?: string; alias?: string; joined: boolean; at?: Span }
  | { kind: "subquery"; joined: boolean; at?: Span }
  | { kind: "function"; name: string; joined: boolean; at?: Span };

export interface ParsedSelect {
  kind: "select";
  distinct: boolean;
  columns: { expr: ParsedExpr; alias?: string; at?: Span }[];
  from: ParsedFrom[];
  where?: ParsedExpr;
  groupBy: ParsedExpr[];
  having?: ParsedExpr;
  orderBy: {
    expr: ParsedExpr;
    direction?: "asc" | "desc";
    nulls?: "first" | "last";
    at?: Span;
  }[];
  limit?: ParsedExpr;
  offset?: ParsedExpr;
  /** Clause-level constructs that RQL refuses (DISTINCT ON, FOR UPDATE, column aliases). */
  foreign: ForeignNode[];
  at?: Span;
}

export type ParsedStatement =
  | ParsedSelect
  | { kind: "set_operation"; op: string; at?: Span }
  | { kind: "with"; at?: Span }
  | { kind: "values"; at?: Span }
  | { kind: "other"; statementType: string; at?: Span };

export type ParseResult =
  | { ok: true; statements: ParsedStatement[] }
  | { ok: false; message: string; at?: Span };
