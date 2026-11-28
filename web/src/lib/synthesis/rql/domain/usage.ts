import type { ParsedExpr, ParsedStatement } from "./ast";
import type { RqlTableName } from "./catalog";

/**
 * What one project has and already asks, as the RQL field orders its list by it (decision
 * `completion-ranking`): the columns and properties that hold data, and the names its saved
 * queries use, alone and two together. No tracking: a loader reads it from what Ratel stores.
 * Pure and safe for the browser.
 */

export interface RqlCompletionUsage {
  /** By table, the columns that hold data in the project's newest rows. A table not here was not read. */
  columnsWithData: Partial<Record<RqlTableName, string[]>>;
  /** The trace properties that hold values in the range; null when not known. */
  propertiesWithData: string[] | null;
  /** How many saved queries name each name, by `usageKey`. */
  uses: Record<string, number>;
  /** How many saved queries name two names together, by `pairKey`. */
  together: Record<string, number>;
}

export type UsageKind = "table" | "column" | "function" | "property";

/** No history: the list keeps its fixed start order. */
export const NO_USAGE: RqlCompletionUsage = {
  columnsWithData: {},
  propertiesWithData: null,
  uses: {},
  together: {},
};

/** The names read in one saved query, at most: a wide query adds no more pairs. */
export const MAX_NAMES_PER_QUERY = 32;
/** The pairs kept, the most frequent first: what the page sends to the field stays small. */
export const MAX_PAIRS = 1_000;

/** The uses and pairs of the saved queries, one parse result per query. Text that did not parse counts nothing. */
export function savedQueryUsage(
  parsed: readonly ParsedStatement[][],
): Pick<RqlCompletionUsage, "uses" | "together"> {
  const uses: Record<string, number> = {};
  const together: Record<string, number> = {};
  for (const statements of parsed) {
    const names = [...namesOf(statements)].slice(0, MAX_NAMES_PER_QUERY);
    for (const name of names) uses[name] = (uses[name] ?? 0) + 1;
    for (const [index, first] of names.entries())
      for (const second of names.slice(index + 1)) {
        const key = pairKey(first, second);
        together[key] = (together[key] ?? 0) + 1;
      }
  }
  const kept = Object.entries(together)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_PAIRS);
  return { uses, together: Object.fromEntries(kept) };
}

/** The key of a name: RQL words in lower case, a property name as it is written. */
export function usageKey(kind: UsageKind, name: string): string {
  return `${kind}:${kind === "property" ? name : name.toLowerCase()}`;
}

/** The key of two names, the same in either order. */
export function pairKey(first: string, second: string): string {
  return first < second ? `${first}\n${second}` : `${second}\n${first}`;
}

/** The names of one query: its tables, columns, functions and property keys, each once. */
function namesOf(statements: readonly ParsedStatement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (statement.kind !== "select") continue;
    for (const from of statement.from)
      if (from.kind === "table") names.add(usageKey("table", from.name));
    const exprs = [
      ...statement.columns.map(({ expr }) => expr),
      ...(statement.where ? [statement.where] : []),
      ...statement.groupBy,
      ...(statement.having ? [statement.having] : []),
      ...statement.orderBy.map(({ expr }) => expr),
    ];
    for (const expr of exprs) addNames(expr, names);
  }
  return names;
}

function addNames(expr: ParsedExpr, names: Set<string>): void {
  switch (expr.kind) {
    case "column":
      names.add(usageKey("column", expr.name));
      return;
    case "call":
      names.add(usageKey("function", expr.name));
      for (const arg of expr.args) addNames(arg, names);
      return;
    case "index":
      if (
        expr.target.kind === "column" &&
        expr.target.name.toLowerCase() === "properties" &&
        expr.key.kind === "string"
      )
        names.add(usageKey("property", expr.key.value));
      else addNames(expr.target, names);
      return;
    case "binary":
      addNames(expr.left, names);
      addNames(expr.right, names);
      return;
    case "unary":
      addNames(expr.operand, names);
      return;
    case "between":
      for (const part of [expr.value, expr.low, expr.high]) addNames(part, names);
      return;
    case "in":
      for (const part of [expr.value, ...expr.items]) addNames(part, names);
      return;
    default:
      return;
  }
}
