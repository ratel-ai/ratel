import type { ParseResult } from "./ast";
import type { RqlTableName, RqlType } from "./catalog";
import { checkQuery, type ParamValue } from "./check";
import { RqlCompileError, type RqlError } from "./errors";
import { guardText } from "./guard";
import { RQL_LIMITS } from "./limits";
import type { RqlPageFilter } from "./page-filter";
import { rewriteSelect } from "./rewrite";
import { type RqlWindow, resolveWindow } from "./window";

export interface RqlCompileOptions {
  /** The time the query runs at: the end of the default window. */
  now: Date;
  /** The window the caller asks for. The default is the last `defaultWindowHours` before `now`. */
  window?: RqlWindow;
  /** The filter of the page the query runs under: rows whose trace matches (`page-filter.ts`). */
  filter?: RqlPageFilter;
}

export type RqlCompileResult =
  | {
      ok: true;
      /** Postgres SQL over the views of the `rql` schema. The output columns are `c1`, `c2`... */
      sql: string;
      /** The values of `$1`, `$2`...: `$1` and `$2` are the window bounds. */
      params: ParamValue[];
      /** The index in `params` of the LIMIT: a parameter of its own, shared with no literal. */
      limitParam: number;
      /** The name and the type of each output column, in the order of `c1`, `c2`... */
      columns: { name: string; type: RqlType }[];
      table: RqlTableName;
      window: { from: string; to: string };
      /** The most rows the query gives: its LIMIT, lowered to `maxLimit`. */
      limit: number;
      /**
       * The query gives one row at most: no GROUP BY, and each column an aggregate. What an alert
       * compares needs it. HAVING can still keep no row.
       */
      oneRow: boolean;
    }
  | { ok: false; error: RqlError };

/** Compiles query text with a parser: parse, check, then rewrite. Never throws on a query. */
export function compileQuery(
  text: string,
  parse: (text: string) => ParseResult,
  options: RqlCompileOptions,
): RqlCompileResult {
  try {
    if (text.trim() === "") {
      return {
        ok: false,
        error: {
          code: "empty_query",
          message: "The query is empty.",
          fix: "Write one SELECT statement, for example: select count(*) from traces.",
        },
      };
    }
    guardText(text);
    const window = resolveWindow(options.now, options.window);
    const parsed = parse(text);
    guardDepth(parsed);
    const select = checkQuery(parsed);
    const limit = Math.min(select.limit ?? RQL_LIMITS.defaultLimit, RQL_LIMITS.maxLimit);
    const { sql, params, limitParam } = rewriteSelect(select, window, limit, options.filter);
    return {
      ok: true,
      sql,
      params,
      limitParam,
      columns: select.items.map((item) => ({ name: item.name, type: item.type })),
      table: select.table.name,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      limit,
      oneRow:
        select.groupBy.length === 0 &&
        !select.distinct &&
        select.items.every(({ expr }) => expr.aggregate),
    };
  } catch (error) {
    if (error instanceof RqlCompileError) return { ok: false, error: error.error };
    // A tree deeper than the stack: refused as the depth check refuses it.
    if (error instanceof RangeError && /call stack/i.test(error.message))
      return { ok: false, error: tooDeep() };
    throw error;
  }
}

/** Refuses a parsed tree deeper than `maxExpressionDepth`, with no recursion. */
function guardDepth(parsed: ParseResult): void {
  if (!parsed.ok) return;
  const stack: { node: unknown; depth: number }[] = [{ node: parsed.statements, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > RQL_LIMITS.maxExpressionDepth) throw new RqlCompileError(tooDeep());
    if (node === null || typeof node !== "object") continue;
    const nested = Array.isArray(node) ? depth : depth + 1;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "at" && value !== null && typeof value === "object") {
        stack.push({ node: value, depth: nested });
      }
    }
  }
}

function tooDeep(): RqlError {
  return {
    code: "syntax_error",
    message: `The query nests expressions more than ${RQL_LIMITS.maxExpressionDepth} levels deep.`,
    fix: "Write a flatter expression: fewer NOT, parentheses or operators in a chain.",
  };
}
